# Pluggable Core Storage

Today plugins (OpenAPI, MCP, GraphQL, WorkOS Vault) each expose a typed
`*Store` interface with named methods (`upsertSource`, `removeSource`,
etc.) that users can override wholesale or decoratively. The core
tables (`source`, `tool`, `secret`, `definition`) are the odd one out:
the executor reaches into them via `core.create({ model: "tool", data })`
on a raw `DBAdapter`.

Two problems that fall out of that:

1. **Sidecar integrations need string-matching.** A user who wants to
   mirror tool writes to Algolia has to write `if (model === "tool")`
   inside an adapter wrapper. Brittle; no type help.
2. **Inconsistency.** Two patterns for the same job — plugins use
   typed stores, core does not. Contributors have to learn both.

## The refactor

Introduce `CoreStore`, modelled on the existing plugin stores.

```ts
export interface CoreStore {
  // sources
  readonly putSource: (source: StoredSource) => Effect.Effect<void, Error>;
  readonly getSource: (id: string) => Effect.Effect<StoredSource | null, Error>;
  readonly listSources: () => Effect.Effect<readonly StoredSource[], Error>;
  readonly removeSource: (id: string) => Effect.Effect<void, Error>;

  // tools
  readonly putTools: (tools: readonly StoredTool[]) => Effect.Effect<void, Error>;
  readonly getTool: (id: string) => Effect.Effect<StoredTool | null, Error>;
  readonly listTools: () => Effect.Effect<readonly StoredTool[], Error>;
  readonly removeToolsBySource: (sourceId: string) => Effect.Effect<void, Error>;

  // definitions
  readonly putDefinitions: (defs: readonly StoredDefinition[]) => Effect.Effect<void, Error>;
  readonly listDefinitionsBySource: (sourceId: string) => Effect.Effect<readonly StoredDefinition[], Error>;
  readonly removeDefinitionsBySource: (sourceId: string) => Effect.Effect<void, Error>;

  // secrets (routing rows; provider-specific data lives in provider)
  readonly putSecret: (secret: StoredSecret) => Effect.Effect<void, Error>;
  readonly getSecret: (id: string) => Effect.Effect<StoredSecret | null, Error>;
  readonly listSecrets: () => Effect.Effect<readonly StoredSecret[], Error>;
  readonly removeSecret: (id: string) => Effect.Effect<void, Error>;
}

export const makeDefaultCoreStore = (deps: {
  adapter: DBAdapter;
  scope: Scope;
}): CoreStore => { /* typedAdapter<CoreSchema> wiring, one place */ };
```

## Wiring — defaults passed in deps, force the spread

Same ergonomics as the future `search` hook and the existing plugin
`storage:` options (which should be renamed to match, see below):

```ts
export interface CoreStorageDeps {
  readonly adapter: DBAdapter;
  readonly scope: Scope;
  readonly defaults: CoreStore;
}

export interface ExecutorConfig<TPlugins> {
  // ...
  readonly coreStorage?: (deps: CoreStorageDeps) => CoreStore;
}

// Inside createExecutor:
const defaults = makeDefaultCoreStore({ adapter, scope });
const core = config.coreStorage
  ? config.coreStorage({ adapter, scope, defaults })
  : defaults;
// Executor now calls core.putTools(...), core.removeSource(...), etc.
// No more adapter.create({ model: "tool", ... }) scattered through executor.ts.
```

**Why defaults-in-deps, not `Partial<CoreStore>`:**

- Partial overrides silently fall back on typos (`putTool` vs `putTools`)
  with no type help.
- Anyone implementing from scratch (test doubles, a non-drizzle backend)
  gets no squigglies when they miss a method.
- Defaults-in-deps gets "only write what you override" ergonomics *and*
  keeps the full `CoreStore` return type enforced.

## What it unlocks

**Algolia sidecar — no string-match, just method overrides:**

```ts
const executor = yield* createExecutor({
  scope, adapter, blobs, plugins,

  coreStorage: ({ defaults }) => ({
    ...defaults,
    putTools: (tools) =>
      Effect.gen(function* () {
        yield* defaults.putTools(tools);
        yield* Effect.promise(() => algolia.saveObjects({
          indexName: `tools_${scope.id}`,
          objects: tools.map((t) => ({ objectID: t.id, ...t })),
        }));
      }),
    removeToolsBySource: (sourceId) =>
      Effect.gen(function* () {
        const affected = yield* defaults.listTools();
        yield* defaults.removeToolsBySource(sourceId);
        yield* Effect.promise(() => algolia.deleteObjects({
          indexName: `tools_${scope.id}`,
          objectIDs: affected.filter((t) => t.sourceId === sourceId).map((t) => t.id),
        }));
      }),
  }),
});
```

Test doubles become trivial — either hand-roll the whole `CoreStore`
against a `Map`, or override just the couple of methods a test cares
about.

## Aligning plugin `storage:` options

Today each plugin exposes `storage: (deps) => makeDefaultOpenapiStore(deps)`.
The factory name leaks. Rename to the defaults-in-deps shape:

```ts
// before
storage: (deps) => makeDefaultOpenapiStore(deps)

// after
storage: ({ defaults }) => defaults   // no-op, identical to leaving off `storage:`

// override one method
storage: ({ defaults }) => ({ ...defaults, upsertSource: myUpsert })
```

Mechanical sweep across openapi / mcp / graphql / workos-vault plugins.
Worth doing in the same PR so there's one pattern everywhere.

## Scope of the refactor

Not intellectually hard, but a broad diff:

- Every `core.create / findOne / findMany / upsert({ model: "X" })` call
  in `packages/core/sdk/src/executor.ts` becomes a named method on
  `CoreStore`. That's the bulk of the work.
- `makeDefaultCoreStore` is the one place the model-string wiring lives.
- Plugin `storage:` signature update + every plugin's default store
  factory renamed to follow the `defaults` contract.
- Docs/readme updates showing the new override pattern.

Ideally lands *before* pluggable search — the search sidecar story
depends on this refactor to avoid the `if (model === "tool")` antipattern
I'd otherwise be stuck with.
