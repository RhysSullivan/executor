import { Effect, FiberRef } from "effect";
import {
  StorageError,
  typedAdapter,
  type DBAdapter,
  type DBSchema,
  type DBTransactionAdapter,
  type StorageFailure,
  type TypedAdapter,
} from "@executor/storage-core";

import {
  pluginBlobStore,
  type BlobStore,
} from "./blob";
import {
  coreSchema,
  type CoreSchema,
  type DefinitionsInput,
  type SourceInput,
  type SourceRow,
  type ToolAnnotations,
  type ToolRow,
} from "./core-schema";
import {
  ElicitationDeclinedError,
  ElicitationResponse,
  FormElicitation,
  type ElicitationHandler,
  type ElicitationRequest,
} from "./elicitation";
import {
  NoHandlerError,
  PluginNotLoadedError,
  SourceRemovalNotAllowedError,
  ToolInvocationError,
  ToolNotFoundError,
} from "./errors";
import { ScopeId, SecretId, ToolId } from "./ids";
import type {
  AnyPlugin,
  Elicit,
  PluginCtx,
  PluginExtensions,
  StaticSourceDecl,
  StaticToolDecl,
  StorageDeps,
} from "./plugin";
import type { Scope } from "./scope";
import {
  SecretRef,
  SetSecretInput,
  type SecretProvider,
} from "./secrets";
import {
  ToolSchema,
  type Source,
  type SourceDetectionResult,
  type Tool,
  type ToolListFilter,
} from "./types";
import { buildToolTypeScriptPreview } from "./schema-types";
import { scopeAdapter } from "./scoped-adapter";

// ---------------------------------------------------------------------------
// InvokeOptions — passed to `executor.tools.invoke(id, args, options)`.
// The `onElicitation` handler is threaded into the `elicit` function
// exposed on plugin ctx / InvokeToolInput. Tools that never elicit
// simply don't call it.
//
// The "accept-all" sentinel is convenient for tests and CLI automation —
// every elicitation request gets auto-accepted with an empty content
// payload. For real interactive hosts, pass a real handler.
// ---------------------------------------------------------------------------

export interface InvokeOptions {
  readonly onElicitation?: ElicitationHandler | "accept-all";
}

const acceptAllHandler: ElicitationHandler = () =>
  Effect.succeed(new ElicitationResponse({ action: "accept" }));

const resolveElicitationHandler = (
  options: InvokeOptions | undefined,
): ElicitationHandler => {
  const handler = options?.onElicitation;
  if (!handler || handler === "accept-all") return acceptAllHandler;
  return handler;
};

// ---------------------------------------------------------------------------
// Executor — public surface. Every list/invoke/schema call is a direct
// core-table query (for dynamic rows) unioned with the in-memory static
// pool. No ToolRegistry, no SourceRegistry, no SecretStore services.
// ---------------------------------------------------------------------------

export type Executor<TPlugins extends readonly AnyPlugin[] = []> = {
  /**
   * Precedence-ordered scope stack this executor was configured with.
   * Innermost first. Consumers that need "the display scope" typically
   * pick `scopes.at(-1)` (outermost, e.g. the organization) or
   * `scopes[0]` (innermost, e.g. the current user-in-org) depending on
   * what they're rendering.
   */
  readonly scopes: readonly Scope[];

  readonly tools: {
    readonly list: (
      filter?: ToolListFilter,
    ) => Effect.Effect<readonly Tool[], StorageFailure>;
    /** Fetch a tool's full schema view: JSON schemas with `$defs`
     *  attached from the core `definition` table, plus TypeScript
     *  preview strings rendered from them. Returns `null` for unknown
     *  tool ids. */
    readonly schema: (
      toolId: string,
    ) => Effect.Effect<ToolSchema | null, StorageFailure>;
    /** Every `$defs` entry across every source, grouped by source id.
     *  Used for bulk schema export and downstream TypeScript rendering. */
    readonly definitions: () => Effect.Effect<
      Record<string, Record<string, unknown>>,
      StorageFailure
    >;
    readonly invoke: (
      toolId: string,
      args: unknown,
      options?: InvokeOptions,
    ) => Effect.Effect<
      unknown,
      | ToolNotFoundError
      | PluginNotLoadedError
      | NoHandlerError
      | ToolInvocationError
      | ElicitationDeclinedError
      | StorageFailure
    >;
  };

  readonly sources: {
    readonly list: () => Effect.Effect<readonly Source[], StorageFailure>;
    readonly remove: (
      sourceId: string,
    ) => Effect.Effect<void, SourceRemovalNotAllowedError | StorageFailure>;
    readonly refresh: (sourceId: string) => Effect.Effect<void, StorageFailure>;
    /** URL autodetection — fans out to every plugin's `detect` hook
     *  (if declared), returns every high/medium/low-confidence match.
     *  UI picks a winner from the list. */
    readonly detect: (
      url: string,
    ) => Effect.Effect<readonly SourceDetectionResult[], StorageFailure>;
    /** All `$defs` registered for a single source, keyed by def name. */
    readonly definitions: (
      sourceId: string,
    ) => Effect.Effect<Record<string, unknown>, StorageFailure>;
  };

  readonly secrets: {
    readonly get: (
      id: string,
    ) => Effect.Effect<string | null, StorageFailure>;
    /** Fast-path existence check — hits the core `secret` routing table
     *  only, never calls the provider. Use this for UI state ("secret
     *  missing, prompt to add") to avoid keychain permission prompts
     *  or 1password IPC roundtrips on a pre-flight check. */
    readonly status: (
      id: string,
    ) => Effect.Effect<"resolved" | "missing", StorageFailure>;
    readonly set: (
      input: SetSecretInput,
    ) => Effect.Effect<SecretRef, StorageFailure>;
    readonly remove: (id: string) => Effect.Effect<void, StorageFailure>;
    readonly list: () => Effect.Effect<readonly SecretRef[], StorageFailure>;
    readonly providers: () => Effect.Effect<readonly string[]>;
  };

  readonly close: () => Effect.Effect<void, StorageFailure>;
} & PluginExtensions<TPlugins>;

export interface ExecutorConfig<
  TPlugins extends readonly AnyPlugin[] = [],
> {
  /**
   * Precedence-ordered scope stack. Innermost first; typical shape is
   * `[userInOrgScope, orgScope]`. Reads on scoped tables walk the
   * stack (first hit wins for shadow-by-id consumers like secrets and
   * blobs); writes require callers to name an explicit target scope.
   * Must be non-empty.
   */
  readonly scopes: readonly Scope[];
  readonly adapter: DBAdapter;
  readonly blobs: BlobStore;
  readonly plugins?: TPlugins;
}

// ---------------------------------------------------------------------------
// collectSchemas — merge coreSchema with every plugin's declared schema.
// Hosts call this and pass the result to the migration runner (or to
// the adapter factory for backends that auto-migrate from a schema
// manifest) before constructing the executor.
// ---------------------------------------------------------------------------

export const collectSchemas = (
  plugins: readonly AnyPlugin[],
): DBSchema => {
  const merged: Record<string, DBSchema[string]> = { ...coreSchema };
  for (const plugin of plugins) {
    if (!plugin.schema) continue;
    for (const [modelKey, model] of Object.entries(plugin.schema)) {
      if (merged[modelKey]) {
        throw new Error(
          `Duplicate model "${modelKey}" contributed by plugin "${plugin.id}"` +
            ` (reserved by core or another plugin)`,
        );
      }
      merged[modelKey] = model as DBSchema[string];
    }
  }
  return merged;
};

// ---------------------------------------------------------------------------
// Row → public projection conversions
// ---------------------------------------------------------------------------

const rowToSource = (row: SourceRow): Source => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  url: row.url ?? undefined,
  pluginId: row.plugin_id,
  canRemove: Boolean(row.can_remove),
  canRefresh: Boolean(row.can_refresh),
  canEdit: Boolean(row.can_edit),
  runtime: false,
});

const staticDeclToSource = (
  decl: StaticSourceDecl,
  pluginId: string,
): Source => ({
  id: decl.id,
  kind: decl.kind,
  name: decl.name,
  url: decl.url,
  pluginId,
  canRemove: decl.canRemove ?? false,
  canRefresh: decl.canRefresh ?? false,
  canEdit: decl.canEdit ?? false,
  runtime: true,
});

const decodeJsonColumn = (value: unknown): unknown => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const rowToTool = (
  row: ToolRow,
  annotations?: ToolAnnotations,
): Tool => ({
  id: row.id,
  sourceId: row.source_id,
  pluginId: row.plugin_id,
  name: row.name,
  description: row.description,
  inputSchema: decodeJsonColumn(row.input_schema),
  outputSchema: decodeJsonColumn(row.output_schema),
  annotations,
});

const staticDeclToTool = (
  source: StaticSourceDecl,
  tool: StaticToolDecl,
  pluginId: string,
): Tool => ({
  id: `${source.id}.${tool.name}`,
  sourceId: source.id,
  pluginId,
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  outputSchema: tool.outputSchema,
  annotations: tool.annotations,
});

// ---------------------------------------------------------------------------
// Dynamic-row writers — used by ctx.core.sources.register. Static sources
// never touch these functions.
// ---------------------------------------------------------------------------

// Upsert shape: delete any existing source + tools + definitions for
// `input.id` before creating fresh rows. Keeps replayable — boot-time
// sync from executor.jsonc can call register() on rows that already
// exist without tripping a UNIQUE constraint.
const writeSourceInput = (
  core: TypedAdapter<CoreSchema>,
  pluginId: string,
  input: SourceInput,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* deleteSourceById(core, input.id);

    const now = new Date();
    yield* core.create({
      model: "source",
      data: {
        id: input.id,
        scope_id: input.scope,
        plugin_id: pluginId,
        kind: input.kind,
        name: input.name,
        url: input.url ?? undefined,
        can_remove: input.canRemove ?? true,
        can_refresh: input.canRefresh ?? false,
        can_edit: input.canEdit ?? false,
        created_at: now,
        updated_at: now,
      },
      forceAllowId: true,
    });

    if (input.tools.length > 0) {
      yield* core.createMany({
        model: "tool",
        data: input.tools.map((tool) => ({
          id: `${input.id}.${tool.name}`,
          scope_id: input.scope,
          source_id: input.id,
          plugin_id: pluginId,
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema ?? undefined,
          output_schema: tool.outputSchema ?? undefined,
          created_at: now,
          updated_at: now,
        })),
        forceAllowId: true,
      });
    }
  });

const deleteSourceById = (
  core: TypedAdapter<CoreSchema>,
  sourceId: string,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* core.deleteMany({
      model: "tool",
      where: [{ field: "source_id", value: sourceId }],
    });
    yield* core.deleteMany({
      model: "definition",
      where: [{ field: "source_id", value: sourceId }],
    });
    yield* core.delete({
      model: "source",
      where: [{ field: "id", value: sourceId }],
    });
  });

const writeDefinitions = (
  core: TypedAdapter<CoreSchema>,
  pluginId: string,
  input: DefinitionsInput,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* core.deleteMany({
      model: "definition",
      where: [{ field: "source_id", value: input.sourceId }],
    });
    const entries = Object.entries(input.definitions);
    if (entries.length === 0) return;
    const now = new Date();
    yield* core.createMany({
      model: "definition",
      data: entries.map(([name, schema]) => ({
        id: `${input.sourceId}.${name}`,
        scope_id: input.scope,
        source_id: input.sourceId,
        plugin_id: pluginId,
        name,
        schema: schema as Record<string, unknown>,
        created_at: now,
      })),
      forceAllowId: true,
    });
  });

// ---------------------------------------------------------------------------
// Filtering — shared between dynamic (DB) and static (in-memory) pools
// so `tools.list({ query, sourceId })` matches across both.
// ---------------------------------------------------------------------------

const toolMatchesFilter = (tool: Tool, filter: ToolListFilter): boolean => {
  if (filter.sourceId && tool.sourceId !== filter.sourceId) return false;
  if (filter.query) {
    const q = filter.query.toLowerCase();
    const hay = `${tool.name} ${tool.description}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Active-adapter FiberRef. Nested plugin writes read this ref so that
// `ctx.transaction` can swap in a tx-bound adapter handle without changing
// the ctx shape — the root adapter returned by `buildAdapterRouter` below
// resolves its target per call, so any Effect running inside
// `Effect.locally(_, activeAdapterRef, trx)` automatically routes every
// query through the same sql.begin connection. This is what makes nested
// writes atomic on postgres + Hyperdrive without deadlocking a pool of 1.
// ---------------------------------------------------------------------------
const activeAdapterRef = FiberRef.unsafeMake<DBTransactionAdapter | null>(
  null,
);

// A `DBAdapter` whose methods dispatch to the active adapter (tx handle or
// root) on every call. Stable identity for consumers (plugin storage,
// `typedAdapter`, etc.) — they see one adapter object, but the routing is
// decided at call time via the FiberRef above.
const buildAdapterRouter = (root: DBAdapter): DBAdapter => {
  const pick = <A, E>(
    use: (active: DBTransactionAdapter) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(FiberRef.get(activeAdapterRef), (active) =>
      use((active ?? (root as DBTransactionAdapter))),
    );

  return {
    id: root.id,
    create: (data) => pick((a) => a.create(data)),
    createMany: (data) => pick((a) => a.createMany(data)),
    findOne: (data) => pick((a) => a.findOne(data)),
    findMany: (data) => pick((a) => a.findMany(data)),
    count: (data) => pick((a) => a.count(data)),
    update: (data) => pick((a) => a.update(data)),
    updateMany: (data) => pick((a) => a.updateMany(data)),
    delete: (data) => pick((a) => a.delete(data)),
    deleteMany: (data) => pick((a) => a.deleteMany(data)),
    // transaction() always opens a real boundary on the ROOT adapter so the
    // tx uses one real connection from the pool. If we're already inside a
    // parent tx (FiberRef set), skip opening a nested sql.begin — that's
    // the postgres.js + Hyperdrive deadlock path — and just run the
    // callback with the existing tx handle. In both cases the callback
    // sees a FiberRef-substituted adapter so further nested writes thread
    // through.
    transaction: (callback) =>
      Effect.flatMap(FiberRef.get(activeAdapterRef), (active) => {
        if (active) return callback(active);
        return root.transaction((trx) =>
          Effect.locally(callback(trx), activeAdapterRef, trx),
        );
      }),
  } as DBAdapter;
};

// ---------------------------------------------------------------------------
// createExecutor
// ---------------------------------------------------------------------------

interface StaticTools {
  readonly source: StaticSourceDecl;
  readonly tool: StaticToolDecl;
  readonly pluginId: string;
  readonly ctx: PluginCtx<unknown>;
}

interface StaticSources {
  readonly source: StaticSourceDecl;
  readonly pluginId: string;
}

interface PluginRuntime {
  readonly plugin: AnyPlugin;
  readonly storage: unknown;
  readonly ctx: PluginCtx<unknown>;
}

export const createExecutor = <
  const TPlugins extends readonly AnyPlugin[] = [],
>(
  config: ExecutorConfig<TPlugins>,
): Effect.Effect<Executor<TPlugins>, Error> =>
  Effect.gen(function* () {
    const {
      scopes,
      adapter: rootAdapter,
      blobs,
      plugins = [] as unknown as TPlugins,
    } = config;

    if (scopes.length === 0) {
      return yield* Effect.fail(
        new Error("createExecutor requires a non-empty scopes array"),
      );
    }

    // Scope-wrap the root adapter so every read on a tenant-scoped
    // table filters by `scope_id IN (scopes)` and every write's
    // `scope_id` payload is validated to be in the stack. Reads walk
    // the scope array in order at the consumer layer (secrets,
    // blobs) — the adapter itself just bounds the set of rows
    // visible. Only tables whose schema declares `scope_id` are
    // scoped.
    const schema = collectSchemas(plugins);
    const scopeIds = scopes.map((s) => s.id as string);
    const scopedRoot = scopeAdapter(
      rootAdapter,
      { scopes: scopeIds },
      schema,
    );
    const adapter = buildAdapterRouter(scopedRoot);
    const core = typedAdapter<CoreSchema>(adapter);

    // Populated once, never mutated after startup.
    const staticTools = new Map<string, StaticTools>();
    const staticSources = new Map<string, StaticSources>();

    // Per-plugin runtime state.
    const runtimes = new Map<string, PluginRuntime>();
    // Secret providers keyed by `provider.key`.
    const secretProviders = new Map<string, SecretProvider>();
    const extensions: Record<string, object> = {};

    // ------------------------------------------------------------------
    // Secrets facade — fast path is the core `secret` routing table
    // (explicit set()s, keychain entries, etc). Fallback is a walk
    // across providers that implement `list()`, because those are the
    // providers that own their own inventories (1password, file-secrets,
    // workos-vault, env) and enumerate-without-register. Providers
    // without a list() implementation (keychain) never hit the fallback
    // walk because their secrets must be registered through set() to
    // be known at all.
    //
    // Multi-scope behavior: the routing-table lookup pulls every row
    // for this id across the scope stack in a single `IN (...)` query,
    // then sorts innermost-first so a secret registered in a deeper
    // scope shadows one with the same id at a shallower scope (e.g. a
    // user's personal OAuth token wins over an org-wide one). Provider
    // calls stay sequential — scope-partitioning providers (workos-vault,
    // 1password-per-vault) have to be asked per scope because the object
    // name includes the scope — but they're bounded by the number of
    // registered rows for this id, not by scope-stack depth. The
    // provider-enumeration fallback is scope-agnostic: providers like
    // env or 1password don't partition their inventory by executor scope.
    const scopePrecedence = new Map<string, number>();
    scopeIds.forEach((s, i) => scopePrecedence.set(s, i));

    const secretsGet = (
      id: string,
    ): Effect.Effect<string | null, StorageFailure> =>
      Effect.gen(function* () {
        // The scope-wrapped adapter injects `scope_id IN (scopeIds)`
        // automatically, so we only filter by id here.
        const rows = yield* core.findMany({
          model: "secret",
          where: [{ field: "id", value: id }],
        });
        const ordered = [...rows].sort(
          (a, b) =>
            (scopePrecedence.get(a.scope_id as string) ?? Infinity) -
            (scopePrecedence.get(b.scope_id as string) ?? Infinity),
        );
        for (const row of ordered) {
          const provider = secretProviders.get(row.provider as string);
          if (!provider) continue;
          const value = yield* provider.get(id, row.scope_id as string);
          if (value !== null) return value;
        }

        // Fallback: ask every enumerating provider in parallel. First
        // non-null in registration order wins. Providers that throw
        // are treated as "don't have it" so one flaky provider can't
        // block resolution via others. Scope-partitioning providers
        // get asked at the innermost scope as a display default — the
        // enumeration fallback doesn't know which scope the value
        // lives in; flat providers ignore the arg.
        const fallbackScope = scopeIds[0]!;
        const candidates = [...secretProviders.values()].filter(
          (p) => p.list,
        );
        const values = yield* Effect.all(
          candidates.map((p) =>
            p
              .get(id, fallbackScope)
              .pipe(Effect.catchAll(() => Effect.succeed(null))),
          ),
          { concurrency: "unbounded" },
        );
        for (const value of values) if (value !== null) return value;
        return null;
      });

    const secretsSet = (
      input: SetSecretInput,
    ): Effect.Effect<SecretRef, StorageFailure> =>
      Effect.gen(function* () {
        // Validate the write target up front. The adapter would reject
        // an out-of-stack scope too, but catching it here gives a
        // clearer error before we touch the provider.
        if (!scopeIds.includes(input.scope as string)) {
          return yield* Effect.fail(
            new StorageError({
              message:
                `secrets.set targets scope "${input.scope}" which is not ` +
                `in the executor's scope stack [${scopeIds.join(", ")}].`,
              cause: undefined,
            }),
          );
        }

        // Pick provider: explicit or first-writable. Misconfiguration
        // (unknown provider, no writable provider, read-only provider)
        // is a host setup bug — surface as `StorageError` so it lands
        // as a captured InternalError(traceId) at the SDK boundary.
        let target: SecretProvider | undefined;
        if (input.provider) {
          target = secretProviders.get(input.provider);
          if (!target) {
            return yield* Effect.fail(
              new StorageError({
                message: `Unknown secret provider: ${input.provider}`,
                cause: undefined,
              }),
            );
          }
        } else {
          for (const provider of secretProviders.values()) {
            if (provider.writable && provider.set) {
              target = provider;
              break;
            }
          }
          if (!target) {
            return yield* Effect.fail(
              new StorageError({
                message: "No writable secret providers registered",
                cause: undefined,
              }),
            );
          }
        }
        if (!target.writable || !target.set) {
          return yield* Effect.fail(
            new StorageError({
              message: `Secret provider "${target.key}" is read-only`,
              cause: undefined,
            }),
          );
        }

        yield* target.set(input.id, input.value, input.scope as string);

        // Upsert metadata row in the core `secret` table at the
        // caller-named scope. Delete is scoped via the adapter's
        // IN-clause filter to the full stack, which removes any
        // previously-registered row for this id anywhere in the stack
        // (avoids leftover shadow rows from a different scope); then
        // we create fresh at the target scope.
        const now = new Date();
        yield* core.delete({
          model: "secret",
          where: [{ field: "id", value: input.id }],
        });
        yield* core.create({
          model: "secret",
          data: {
            id: input.id,
            scope_id: input.scope,
            name: input.name,
            provider: target.key,
            created_at: now,
          },
          forceAllowId: true,
        });

        return new SecretRef({
          id: input.id,
          scopeId: input.scope,
          name: input.name,
          provider: target.key,
          createdAt: now,
        });
      });

    const secretsRemove = (id: string): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        // Providers don't coordinate on which of them own the id — they
        // each get asked, across every scope in the stack. Flat
        // providers see the same delete call repeated and no-op on
        // the second hit; scope-partitioned providers use the scope
        // arg to pick the right partition. Fan out so one slow
        // provider doesn't serialize the rest.
        const deleters = [...secretProviders.values()].filter(
          (p): p is typeof p & { delete: NonNullable<typeof p.delete> } =>
            !!(p.writable && p.delete),
        );
        const tasks = deleters.flatMap((p) =>
          scopeIds.map((scopeId) => p.delete(id, scopeId)),
        );
        yield* Effect.all(tasks, { concurrency: "unbounded" });
        yield* core.delete({
          model: "secret",
          where: [{ field: "id", value: id }],
        });
      });

    // List is a union of two sources of truth:
    //
    //   1. Core `secret` rows — secrets explicitly registered via
    //      executor.secrets.set(...). These carry their pinned provider
    //      and are authoritative for routing (get() uses them).
    //   2. Each provider's own `list()` — for read-only or
    //      already-populated providers (1password, file-secrets,
    //      workos-vault, env), the provider enumerates what's actually
    //      in its backend. These show up in the list even if the user
    //      never called set() through the executor.
    //
    // Dedupe by secret id; core rows win over provider-enumerated ones
    // so that routing information in the core table is authoritative.
    // Providers without a list() method (e.g. keychain) contribute
    // only via the core table path.
    //
    // Multi-scope: core rows from any scope in the stack show up
    // (adapter filters by `scope_id IN`), each tagged with its own
    // `scope_id`. When the same id appears in multiple scopes, the
    // innermost wins — same rule as `secretsGet`. Provider-enumerated
    // entries don't know what scope they belong to and are attributed
    // to the innermost scope as a display default.
    const secretsList = (): Effect.Effect<readonly SecretRef[], StorageFailure> =>
      Effect.gen(function* () {
        const byId = new Map<string, SecretRef>();

        // Core routing rows first. Adapter returns rows from every
        // scope in the stack; resolve collisions using the caller's
        // precedence order (innermost first).
        const rows = yield* core.findMany({ model: "secret" });
        const precedence = new Map<string, number>();
        scopeIds.forEach((id, index) => precedence.set(id, index));
        const pick = (row: typeof rows[number]) => {
          const existing = byId.get(row.id);
          const incomingScope = row.scope_id as string;
          const incomingRank = precedence.get(incomingScope) ?? Number.MAX_SAFE_INTEGER;
          if (existing) {
            const existingRank = precedence.get(existing.scopeId as string) ?? Number.MAX_SAFE_INTEGER;
            if (existingRank <= incomingRank) return;
          }
          byId.set(
            row.id,
            new SecretRef({
              id: SecretId.make(row.id),
              scopeId: ScopeId.make(incomingScope),
              name: row.name,
              provider: row.provider,
              createdAt:
                row.created_at instanceof Date
                  ? row.created_at
                  : new Date(row.created_at as string),
            }),
          );
        };
        for (const row of rows) pick(row);

        // Then every provider that can enumerate itself, in parallel.
        // If a provider fails to list (unlocked vault, network error),
        // swallow the failure so one flaky provider can't block the
        // whole list. Merge in registration order afterwards so the
        // "first provider wins" precedence stays deterministic.
        const attribution = scopes[0]!.id;
        const listers = [...secretProviders.entries()].filter(
          ([, p]) => p.list,
        );
        const lists = yield* Effect.all(
          listers.map(([key, p]) =>
            p
              .list!()
              .pipe(
                Effect.catchAll(() => Effect.succeed([] as const)),
                Effect.map((entries) => ({ key, entries })),
              ),
          ),
          { concurrency: "unbounded" },
        );
        for (const { key, entries } of lists) {
          for (const entry of entries) {
            if (byId.has(entry.id)) continue; // core row wins
            byId.set(
              entry.id,
              new SecretRef({
                id: SecretId.make(entry.id),
                scopeId: attribution,
                name: entry.name,
                provider: key,
                createdAt: new Date(),
              }),
            );
          }
        }

        return Array.from(byId.values());
      });

    // Same union shape as secretsList but projected to the leaner
    // SecretListEntry shape that plugins get via ctx.secrets.list().
    const secretsListForCtx = () =>
      Effect.gen(function* () {
        const list = yield* secretsList();
        return list.map((ref) => ({
          id: ref.id as unknown as string,
          name: ref.name,
          provider: ref.provider,
        }));
      });

    // ------------------------------------------------------------------
    // Plugin wiring — build ctx, run extension, populate static pools,
    // register secret providers. No adapter reads here.
    // ------------------------------------------------------------------
    for (const plugin of plugins) {
      if (runtimes.has(plugin.id)) {
        return yield* Effect.fail(
          new Error(`Duplicate plugin id: ${plugin.id}`),
        );
      }

      // Plugin-facing typed view. `StorageError` and `UniqueViolationError`
      // flow through the typed channel unchanged — plugins can
      // `catchTag("UniqueViolationError", …)` to translate to their own
      // user-facing errors; the HTTP edge (see @executor/api
      // `withCapture`) is responsible for translating any
      // `StorageError` that still escapes into the opaque InternalError.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const storageDeps: StorageDeps<any> = {
        scopes,
        adapter: typedAdapter(adapter) as never,
        // Blob keys are namespaced by `<scope>/<plugin>` so two tenants
        // sharing a backing BlobStore can't collide or leak on the
        // same `(plugin, key)` pair. The store's `get`/`has` walk the
        // scope stack (innermost first); `put`/`delete` require the
        // plugin to name a target scope explicitly.
        blobs: pluginBlobStore(blobs, scopeIds, plugin.id),
      };
      const storage = plugin.storage(storageDeps);

      const ctx: PluginCtx<unknown> = {
        scopes,
        storage,
        core: {
          sources: {
            register: (input: SourceInput) =>
              Effect.gen(function* () {
                // Guard: reject a dynamic source whose id collides with
                // a static source id, or any of whose would-be tool ids
                // collide with a static tool id. Tool ids are
                // `${source_id}.${tool.name}` — static and dynamic
                // share the same string space. Fails as `StorageError`
                // so the HTTP edge surfaces it as `InternalError(traceId)`.
                if (staticSources.has(input.id)) {
                  return yield* Effect.fail(
                    new StorageError({
                      message: `Source id "${input.id}" collides with a static source`,
                      cause: undefined,
                    }),
                  );
                }
                for (const tool of input.tools) {
                  const fqid = `${input.id}.${tool.name}`;
                  if (staticTools.has(fqid)) {
                    return yield* Effect.fail(
                      new StorageError({
                        message: `Tool id "${fqid}" collides with a static tool`,
                        cause: undefined,
                      }),
                    );
                  }
                }
                // Wrap in adapter.transaction so a standalone register()
                // call is atomic (source create + tools createMany group
                // together). When already inside a parent ctx.transaction,
                // the router short-circuits to the active tx handle
                // instead of opening a nested sql.begin — that nested
                // sql.begin is the postgres.js + pool=1 deadlock path.
                yield* adapter.transaction(() =>
                  writeSourceInput(core, plugin.id, input),
                );
              }),
            unregister: (sourceId: string) =>
              adapter.transaction(() => deleteSourceById(core, sourceId)),
          },
          definitions: {
            register: (input: DefinitionsInput) =>
              adapter.transaction(() =>
                writeDefinitions(core, plugin.id, input),
              ),
          },
        },
        secrets: {
          get: (id) => secretsGet(id),
          list: () => secretsListForCtx(),
          set: (input) => secretsSet(input),
          remove: (id) => secretsRemove(id),
        },
        // Open one real tx boundary and route every nested write inside
        // `effect` through that same handle via the activeAdapterRef —
        // see buildAdapterRouter above. Caller-typed errors (`E`)
        // propagate unchanged; storage failures also stay typed
        // (`StorageFailure`) so the HTTP edge wrapper can translate them.
        transaction: <A, E>(effect: Effect.Effect<A, E>) =>
          adapter.transaction(() => effect) as Effect.Effect<
            A,
            E | StorageFailure
          >,
      };

      // Build extension FIRST so it's available as `self` when resolving
      // staticSources. Field ordering in the plugin spec matters — TS
      // infers TExtension from `extension`'s return type, then NoInfer
      // locks `self` to that inferred type on `staticSources`.
      const extension: object = plugin.extension
        ? plugin.extension(ctx)
        : {};
      if (plugin.extension) {
        extensions[plugin.id] = extension;
      }

      // Resolve static declarations to the in-memory pools. NO DB WRITES.
      const decls = plugin.staticSources
        ? plugin.staticSources(extension)
        : [];
      for (const source of decls) {
        if (staticSources.has(source.id)) {
          return yield* Effect.fail(
            new Error(
              `Duplicate static source id: ${source.id} (plugin ${plugin.id})`,
            ),
          );
        }
        staticSources.set(source.id, { source, pluginId: plugin.id });

        for (const tool of source.tools) {
          const fqid = `${source.id}.${tool.name}`;
          if (staticTools.has(fqid)) {
            return yield* Effect.fail(
              new Error(
                `Duplicate static tool id: ${fqid} (plugin ${plugin.id})`,
              ),
            );
          }
          staticTools.set(fqid, {
            source,
            tool,
            pluginId: plugin.id,
            ctx,
          });
        }
      }

      runtimes.set(plugin.id, { plugin, storage, ctx });

      if (plugin.secretProviders) {
        const raw =
          typeof plugin.secretProviders === "function"
            ? plugin.secretProviders(ctx)
            : plugin.secretProviders;
        const providers = Effect.isEffect(raw) ? yield* raw : raw;
        for (const provider of providers) {
          if (secretProviders.has(provider.key)) {
            return yield* Effect.fail(
              new Error(
                `Duplicate secret provider key: ${provider.key} (from plugin ${plugin.id})`,
              ),
            );
          }
          secretProviders.set(provider.key, provider);
        }
      }
    }

    // ------------------------------------------------------------------
    // Executor surface
    // ------------------------------------------------------------------
    const listSources = () =>
      Effect.gen(function* () {
        const dynamic = yield* core.findMany({ model: "source" });
        const staticList: Source[] = [];
        for (const { source, pluginId } of staticSources.values()) {
          staticList.push(staticDeclToSource(source, pluginId));
        }
        const merged = [...staticList, ...dynamic.map(rowToSource)];
        yield* Effect.annotateCurrentSpan({
          "executor.sources.static_count": staticList.length,
          "executor.sources.dynamic_count": dynamic.length,
        });
        return merged;
      }).pipe(Effect.withSpan("executor.sources.list"));

    // Bulk-resolve annotations across a set of dynamic tool rows by
    // grouping them under their owning plugin's resolveAnnotations
    // callback. One plugin call per (plugin_id, source_id) pair, not
    // per row. Plugins without a resolver simply contribute no
    // annotations for their rows.
    const resolveAnnotationsFor = (rows: readonly ToolRow[]) =>
      Effect.gen(function* () {
        const result = new Map<string, ToolAnnotations>();
        if (rows.length === 0) return result;

        // Group by (plugin_id, source_id)
        const groups = new Map<string, ToolRow[]>();
        for (const row of rows) {
          const key = `${row.plugin_id}\u0000${row.source_id}`;
          const bucket = groups.get(key);
          if (bucket) bucket.push(row);
          else groups.set(key, [row]);
        }

        for (const [key, groupRows] of groups) {
          const [pluginId, sourceId] = key.split("\u0000") as [
            string,
            string,
          ];
          const runtime = runtimes.get(pluginId);
          if (!runtime?.plugin.resolveAnnotations) continue;
          const map = yield* runtime.plugin.resolveAnnotations({
            ctx: runtime.ctx,
            sourceId,
            toolRows: groupRows,
          });
          for (const [toolId, annotations] of Object.entries(map)) {
            result.set(toolId, annotations);
          }
        }
        return result;
      });

    const listTools = (filter?: ToolListFilter) =>
      Effect.gen(function* () {
        const dynamic = yield* core.findMany({ model: "tool" });
        const annotations = yield* resolveAnnotationsFor(dynamic).pipe(
          Effect.withSpan("executor.tools.list.annotations"),
        );

        const out: Tool[] = [];
        // Static tools — annotations from the declaration, not a resolver.
        for (const entry of staticTools.values()) {
          out.push(staticDeclToTool(entry.source, entry.tool, entry.pluginId));
        }
        for (const row of dynamic) {
          out.push(rowToTool(row, annotations.get(row.id)));
        }
        const result = filter ? out.filter((t) => toolMatchesFilter(t, filter)) : out;
        yield* Effect.annotateCurrentSpan({
          "executor.tools.static_count": staticTools.size,
          "executor.tools.dynamic_count": dynamic.length,
          "executor.tools.result_count": result.length,
        });
        return result;
      }).pipe(Effect.withSpan("executor.tools.list"));

    // Load all definitions for a single source as a plain map.
    const loadDefinitionsForSource = (sourceId: string) =>
      Effect.gen(function* () {
        const defRows = yield* core.findMany({
          model: "definition",
          where: [{ field: "source_id", value: sourceId }],
        });
        const out: Record<string, unknown> = {};
        for (const row of defRows) out[row.name] = row.schema;
        return out;
      });

    // Render the ToolSchema view for a tool — wraps the raw JSON schemas
    // with attached `$defs` and runs them through the TypeScript preview
    // helpers so the UI gets ready-to-display code samples.
    const buildToolSchemaView = (opts: {
      toolId: string;
      name?: string;
      description?: string;
      sourceId: string | undefined;
      rawInput: unknown;
      rawOutput: unknown;
    }) =>
      Effect.gen(function* () {
        const defs: Record<string, unknown> = opts.sourceId
          ? yield* loadDefinitionsForSource(opts.sourceId).pipe(
              Effect.withSpan("executor.tool.schema.load_defs"),
            )
          : {};

        const attachDefs = (schema: unknown): unknown => {
          if (schema == null || typeof schema !== "object") return schema;
          if (Object.keys(defs).length === 0) return schema;
          return { ...(schema as Record<string, unknown>), $defs: defs };
        };

        const inputSchema = attachDefs(opts.rawInput);
        const outputSchema = attachDefs(opts.rawOutput);

        const defsMap = new Map<string, unknown>(Object.entries(defs));
        const preview = yield* Effect.sync(() =>
          buildToolTypeScriptPreview({ inputSchema, outputSchema, defs: defsMap }),
        ).pipe(
          Effect.withSpan("schema.compile.preview", {
            attributes: {
              "schema.kind": "tool.preview",
              "schema.has_input": inputSchema !== undefined,
              "schema.has_output": outputSchema !== undefined,
              "schema.def_count": defsMap.size,
            },
          }),
        );

        return new ToolSchema({
          id: ToolId.make(opts.toolId),
          name: opts.name,
          description: opts.description,
          inputSchema,
          outputSchema,
          inputTypeScript: preview.inputTypeScript ?? undefined,
          outputTypeScript: preview.outputTypeScript ?? undefined,
          typeScriptDefinitions: preview.typeScriptDefinitions ?? undefined,
        });
      });

    const toolSchema = (toolId: string) =>
      Effect.gen(function* () {
        // Static pool first — static tools have no source in the DB so
        // no `$defs` attach; just wrap the declared schemas.
        const staticEntry = staticTools.get(toolId);
        if (staticEntry) {
          yield* Effect.annotateCurrentSpan({
            "executor.tool.dispatch_path": "static",
            "executor.source_id": staticEntry.source.id,
            "executor.source_kind": staticEntry.source.kind,
          });
          return yield* buildToolSchemaView({
            toolId,
            name: staticEntry.tool.name,
            description: staticEntry.tool.description,
            sourceId: undefined,
            rawInput: staticEntry.tool.inputSchema,
            rawOutput: staticEntry.tool.outputSchema,
          });
        }
        const row = yield* core
          .findOne({
            model: "tool",
            where: [{ field: "id", value: toolId }],
          })
          .pipe(Effect.withSpan("executor.tool.resolve"));
        if (!row) return null;
        yield* Effect.annotateCurrentSpan({
          "executor.tool.dispatch_path": "dynamic",
          "executor.source_id": row.source_id,
          "executor.plugin_id": row.plugin_id,
        });
        return yield* buildToolSchemaView({
          toolId,
          name: row.name,
          description: row.description,
          sourceId: row.source_id,
          rawInput: decodeJsonColumn(row.input_schema),
          rawOutput: decodeJsonColumn(row.output_schema),
        });
      }).pipe(
        Effect.withSpan("executor.tool.schema", {
          attributes: { "mcp.tool.name": toolId },
        }),
      );

    // Bulk definitions accessor — every source's $defs, grouped by
    // source id. One query against the definition table, plus an
    // in-memory group-by.
    const toolsDefinitions = () =>
      Effect.gen(function* () {
        const rows = yield* core.findMany({ model: "definition" });
        const out: Record<string, Record<string, unknown>> = {};
        for (const row of rows) {
          let bucket = out[row.source_id];
          if (!bucket) {
            bucket = {};
            out[row.source_id] = bucket;
          }
          bucket[row.name] = row.schema;
        }
        return out;
      });

    const buildElicit = (toolId: string, args: unknown, options: InvokeOptions | undefined): Elicit => {
      const handler = resolveElicitationHandler(options);
      return (request: ElicitationRequest) =>
        Effect.gen(function* () {
          const tid = ToolId.make(toolId);
          const response: ElicitationResponse = yield* handler({
            toolId: tid,
            args,
            request,
          });
          if (response.action !== "accept") {
            return yield* new ElicitationDeclinedError({
              toolId: tid,
              action: response.action,
            });
          }
          return response;
        });
    };

    const enforceApproval = (
      annotations: ToolAnnotations | undefined,
      toolId: string,
      args: unknown,
      options: InvokeOptions | undefined,
    ) =>
      Effect.gen(function* () {
        if (!annotations?.requiresApproval) return;
        const handler = resolveElicitationHandler(options);
        const tid = ToolId.make(toolId);
        const request = new FormElicitation({
          message: annotations.approvalDescription ?? `Approve ${toolId}?`,
          requestedSchema: {},
        });
        const response = yield* handler({ toolId: tid, args, request });
        if (response.action !== "accept") {
          return yield* new ElicitationDeclinedError({
            toolId: tid,
            action: response.action,
          });
        }
      });

    const invokeTool = (
      toolId: string,
      args: unknown,
      options?: InvokeOptions,
    ) =>
      Effect.gen(function* () {
        const wrapInvocationError = <A, E>(
          effect: Effect.Effect<A, E>,
        ): Effect.Effect<A, ToolInvocationError> =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new ToolInvocationError({
                  toolId: ToolId.make(toolId),
                  message:
                    cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            ),
          );

        // Static path — O(1) map lookup, no DB hit.
        const staticEntry = staticTools.get(toolId);
        if (staticEntry) {
          yield* Effect.annotateCurrentSpan({
            "executor.tool.dispatch_path": "static",
            "executor.source_id": staticEntry.source.id,
            "executor.source_kind": staticEntry.source.kind,
            "executor.plugin_id": staticEntry.pluginId,
          });
          yield* enforceApproval(
            staticEntry.tool.annotations,
            toolId,
            args,
            options,
          ).pipe(Effect.withSpan("executor.tool.enforce_approval"));
          return yield* wrapInvocationError(
            staticEntry.tool.handler({
              ctx: staticEntry.ctx,
              args,
              elicit: buildElicit(toolId, args, options),
            }),
          ).pipe(Effect.withSpan("executor.tool.handler"));
        }

        // Dynamic path — DB lookup + delegate to owning plugin.
        const row = yield* core
          .findOne({
            model: "tool",
            where: [{ field: "id", value: toolId }],
          })
          .pipe(Effect.withSpan("executor.tool.resolve"));
        if (!row) {
          return yield* new ToolNotFoundError({
            toolId: ToolId.make(toolId),
          });
        }
        yield* Effect.annotateCurrentSpan({
          "executor.tool.dispatch_path": "dynamic",
          "executor.source_id": row.source_id,
          "executor.plugin_id": row.plugin_id,
        });
        const runtime = runtimes.get(row.plugin_id);
        if (!runtime) {
          return yield* new PluginNotLoadedError({
            pluginId: row.plugin_id,
            toolId: ToolId.make(toolId),
          });
        }
        if (!runtime.plugin.invokeTool) {
          return yield* new NoHandlerError({
            toolId: ToolId.make(toolId),
            pluginId: row.plugin_id,
          });
        }

        // Ask the plugin to derive annotations for this one row, if it
        // has a resolver. Cheap because the plugin typically already
        // needs to load its enrichment data to invoke the tool —
        // implementations should structure their resolver + invokeTool
        // around a single storage read.
        let annotations: ToolAnnotations | undefined;
        if (runtime.plugin.resolveAnnotations) {
          const map = yield* runtime.plugin
            .resolveAnnotations({
              ctx: runtime.ctx,
              sourceId: row.source_id,
              toolRows: [row],
            })
            .pipe(Effect.withSpan("executor.tool.resolve_annotations"));
          annotations = map[toolId];
        }
        yield* enforceApproval(annotations, toolId, args, options).pipe(
          Effect.withSpan("executor.tool.enforce_approval"),
        );

        return yield* wrapInvocationError(
          runtime.plugin.invokeTool({
            ctx: runtime.ctx,
            toolRow: row,
            args,
            elicit: buildElicit(toolId, args, options),
          }),
        ).pipe(Effect.withSpan("executor.tool.handler"));
      }).pipe(
        Effect.withSpan("executor.tool.invoke", {
          attributes: {
            "mcp.tool.name": toolId,
          },
        }),
      );

    const removeSource = (sourceId: string) =>
      Effect.gen(function* () {
        // Block removal of static sources structurally.
        if (staticSources.has(sourceId)) {
          return yield* new SourceRemovalNotAllowedError({ sourceId });
        }
        const sourceRow = yield* core.findOne({
          model: "source",
          where: [{ field: "id", value: sourceId }],
        });
        if (!sourceRow) return;
        if (!sourceRow.can_remove) {
          return yield* new SourceRemovalNotAllowedError({ sourceId });
        }
        const runtime = runtimes.get(sourceRow.plugin_id);
        // Group the plugin's own cleanup + the core row delete into one
        // tx so a removeSource never leaves orphan rows on failure. The
        // router short-circuits on nested calls when the caller is
        // already inside a parent ctx.transaction.
        yield* adapter.transaction(() =>
          Effect.gen(function* () {
            if (runtime?.plugin.removeSource) {
              yield* runtime.plugin.removeSource({
                ctx: runtime.ctx,
                sourceId,
              });
            }
            yield* deleteSourceById(core, sourceId);
          }),
        );
      });

    const refreshSource = (sourceId: string) =>
      Effect.gen(function* () {
        if (staticSources.has(sourceId)) return;
        const sourceRow = yield* core.findOne({
          model: "source",
          where: [{ field: "id", value: sourceId }],
        });
        if (!sourceRow) return;
        const runtime = runtimes.get(sourceRow.plugin_id);
        if (runtime?.plugin.refreshSource) {
          yield* runtime.plugin.refreshSource({
            ctx: runtime.ctx,
            sourceId,
          });
        }
      });

    // URL autodetection — fan out across every plugin that declared a
    // `detect` hook. Collect all non-null results. Plugin-level detect
    // implementations should swallow fetch errors and return null, so
    // one flaky plugin doesn't block the whole dispatch.
    const detectSource = (url: string) =>
      Effect.gen(function* () {
        const results: SourceDetectionResult[] = [];
        for (const runtime of runtimes.values()) {
          if (!runtime.plugin.detect) continue;
          const result = yield* runtime.plugin
            .detect({ ctx: runtime.ctx, url })
            .pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (result) results.push(result);
        }
        return results;
      });

    // Per-source definitions accessor — one query, one mapping pass.
    const sourceDefinitions = (sourceId: string) =>
      loadDefinitionsForSource(sourceId);

    // Fast-path existence check. Hits the core `secret` routing row
    // first (no provider call). If no routing row, walks enumerating
    // providers and checks their lists for a matching id — same
    // fallback strategy as secretsGet. Still avoids provider.get()
    // so no keychain permission prompts / 1password value IPC fires
    // just to ask "does this exist?"
    const secretsStatus = (
      id: string,
    ): Effect.Effect<"resolved" | "missing", StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* core.findOne({
          model: "secret",
          where: [{ field: "id", value: id }],
        });
        if (row) return "resolved";

        for (const provider of secretProviders.values()) {
          if (!provider.list) continue;
          const entries = yield* provider
            .list()
            .pipe(Effect.catchAll(() => Effect.succeed([] as const)));
          if (entries.some((e) => e.id === id)) return "resolved";
        }
        return "missing";
      });

    const close = () =>
      Effect.gen(function* () {
        for (const runtime of runtimes.values()) {
          if (runtime.plugin.close) {
            yield* runtime.plugin.close();
          }
        }
      });

    // Public Executor surface — storage-backed methods surface
    // `StorageFailure` (StorageError | UniqueViolationError) raw. The
    // HTTP edge wraps this surface with `withCapture` to
    // translate `StorageError` → `InternalError({ traceId })`; non-HTTP
    // consumers (CLI, Promise SDK, tests) see the raw typed channel.
    const base = {
      scopes,
      tools: {
        list: listTools,
        schema: toolSchema,
        definitions: toolsDefinitions,
        invoke: invokeTool,
      },
      sources: {
        list: listSources,
        remove: removeSource,
        refresh: refreshSource,
        detect: detectSource,
        definitions: sourceDefinitions,
      },
      secrets: {
        get: secretsGet,
        status: secretsStatus,
        set: secretsSet,
        remove: secretsRemove,
        list: secretsList,
        providers: () =>
          Effect.sync(
            () => Array.from(secretProviders.keys()) as readonly string[],
          ),
      },
      close,
    };

    // Cast through `unknown` because the impl effects can include
    // `Error` from plugin-supplied callbacks (resolveAnnotations etc.) —
    // those leak via the helper functions and won't be cleaned until
    // every plugin tightens its surface to typed errors. The runtime
    // shape matches `Executor<TPlugins>`.
    return Object.assign(base, extensions) as unknown as Executor<TPlugins>;
  });
