# Pluggable Tool Search

The path to making `tools.search()` swappable (Algolia, pg-fts, trigram,
whatever) without baking any of it into the core.

## Today: in-memory linear scan

`searchTools` in `packages/core/execution/src/tool-invoker.ts`:

1. `executor.tools.list()` — `SELECT * FROM tool WHERE scope_id = ?`.
2. In JS, for every tool: normalize + tokenize `id / sourceId / name /
   description`, score per field with weights, apply coverage + exact-
   phrase boosts, filter, sort, slice.

O(N) per query over the scope. Fine at hundreds of tools, painful past
a few thousand. Pulls full rows (including JSONB `input_schema` /
`output_schema`) which aren't even used for scoring — wasted I/O.

## Interface

One method. No `key` — there's only one search provider per executor,
nothing to route.

```ts
export interface ToolSearchProvider {
  readonly search: (q: SearchQuery) => Effect.Effect<readonly SearchMatch[], Error>;
}

export interface SearchQuery {
  readonly scopeId: string;
  readonly query: string;
  readonly namespace?: string;
  readonly limit: number;
}

export interface SearchMatch {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly description: string;
  readonly score: number;
}
```

Call site: `executor.search.query(q)`. (Rename the inner method from
`search` to `query` so we don't get stuck with `executor.search.search(q)`
and still have room to grow the surface — `reindex`, `invalidate` — later.)

## Wiring — force the spread

```ts
export interface SearchDeps {
  readonly listTools: (scopeId: string) => Effect.Effect<readonly Tool[], Error>;
  readonly defaults: ToolSearchProvider;
}

export interface ExecutorConfig<TPlugins> {
  // ...
  readonly search?: (deps: SearchDeps) => ToolSearchProvider;
}
```

Why `listTools` instead of the whole `Executor`: breaks the chicken-and-
egg (executor can't be fully constructed before its search provider is)
and keeps the provider contract tight.

Why "force the spread" instead of `Partial<ToolSearchProvider>`: partial
overrides silently fall back when a method name gets typoed, and
implementing from scratch gets no type hint when a method is missed.
Forcing a full return value via `defaults` in deps gives us both the
"just write what you override" ergonomics and a complete `ToolSearchProvider`
type. Same pattern as plugin `storage:` options and the future `coreStorage:`.

## Override shapes

**Replace entirely:**
```ts
search: ({ listTools }) => algoliaSearch({ listTools }),
```

**Decorate — mix in logging/timing:**
```ts
search: ({ defaults }) => ({
  query: (q) => Effect.gen(function* () {
    const start = Date.now();
    const hits = yield* defaults.query(q);
    console.log(`search ${q.query} scope=${q.scopeId} ms=${Date.now()-start}`);
    return hits;
  }),
}),
```

**Hybrid — try Algolia, fall back to local:**
```ts
search: ({ listTools, defaults }) => ({
  query: (q) =>
    algoliaSearch({ listTools }).query(q).pipe(
      Effect.catchAll(() => defaults.query(q)),
    ),
}),
```

## Indexing side — separate concern

Answering from Algolia/Elasticsearch means keeping an external index in
sync with tool writes. That doesn't belong in the `ToolSearchProvider` —
it's a storage concern. Handled by wrapping the core store (see
`pluggable-storage.md`): override `putTools` / `removeToolsBySource` to
delegate to the default and mirror to the external index.

The two halves are independent:
- Indexing only (manual reindex): override `coreStorage`, leave `search`
  as default.
- Search only (some other populates the index): override `search`, leave
  `coreStorage` as default.

## Cheap wins before external search

Before reaching for Algolia, there's low-hanging fruit on the built-in
scorer:

1. **Projection on `tools.list`** — expose a `select` option so search
   doesn't pull `input_schema` / `output_schema`. Biggest per-query win.
2. **Postgres FTS** — `tsvector` generated column on `(name, description,
   id, source_id)`, GIN index, use `websearch_to_tsquery`. Native
   ranking, fuzzy via `pg_trgm`. Would replace the in-memory scorer for
   the cloud app.
3. **Per-scope LRU** — cache scored results; invalidate on source
   add/update/remove.

The pluggable interface lets us land these as just another provider
(`pgFtsSearch({ db })`) without touching the default path.
