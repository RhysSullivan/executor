import { Deferred, Effect, FiberRef, Option, Schema } from "effect";
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
  ConnectionProviderState,
  ConnectionRef,
  ConnectionRefreshError,
  type ConnectionProvider,
  type CreateConnectionInput,
  type UpdateConnectionTokensInput,
} from "./connections";
import {
  coreSchema,
  type ConnectionRow,
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
  ConnectionNotFoundError,
  ConnectionProviderNotRegisteredError,
  ConnectionReauthRequiredError,
  ConnectionRefreshNotSupportedError,
  NoHandlerError,
  PluginNotLoadedError,
  SecretOwnedByConnectionError,
  SourceRemovalNotAllowedError,
  ToolInvocationError,
  ToolNotFoundError,
} from "./errors";
import { ConnectionId, ScopeId, SecretId, ToolId } from "./ids";
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
    /** Delete a bare (non-connection-owned) secret. Connection-owned
     *  secrets are rejected with `SecretOwnedByConnectionError` — use
     *  `connections.remove` instead. */
    readonly remove: (
      id: string,
    ) => Effect.Effect<void, SecretOwnedByConnectionError | StorageFailure>;
    readonly list: () => Effect.Effect<readonly SecretRef[], StorageFailure>;
    readonly providers: () => Effect.Effect<readonly string[]>;
  };

  readonly connections: {
    readonly get: (
      id: string,
    ) => Effect.Effect<ConnectionRef | null, StorageFailure>;
    readonly list: () => Effect.Effect<readonly ConnectionRef[], StorageFailure>;
    readonly create: (
      input: CreateConnectionInput,
    ) => Effect.Effect<
      ConnectionRef,
      ConnectionProviderNotRegisteredError | StorageFailure
    >;
    readonly updateTokens: (
      input: UpdateConnectionTokensInput,
    ) => Effect.Effect<
      ConnectionRef,
      ConnectionNotFoundError | StorageFailure
    >;
    readonly setIdentityLabel: (
      id: string,
      label: string | null,
    ) => Effect.Effect<void, ConnectionNotFoundError | StorageFailure>;
    readonly accessToken: (
      id: string,
    ) => Effect.Effect<
      string,
      | ConnectionNotFoundError
      | ConnectionProviderNotRegisteredError
      | ConnectionRefreshNotSupportedError
      | ConnectionReauthRequiredError
      | ConnectionRefreshError
      | StorageFailure
    >;
    readonly remove: (id: string) => Effect.Effect<void, StorageFailure>;
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
  scopeId: row.scope_id,
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
  scopeId: undefined,
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
    yield* deleteSourceById(core, input.id, input.scope);

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

// Delete a source and its tools + definitions at ONE specific scope.
// The scoped adapter already narrows reads/writes to the executor's
// stack via `scope_id IN (...)`, but we pin `scope_id = scopeId` here
// so this helper never widens into a stack-wide wipe — a bystander
// scope's rows with a colliding `source_id` must survive.
const deleteSourceById = (
  core: TypedAdapter<CoreSchema>,
  sourceId: string,
  scopeId: string,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    yield* core.deleteMany({
      model: "tool",
      where: [
        { field: "source_id", value: sourceId },
        { field: "scope_id", value: scopeId },
      ],
    });
    yield* core.deleteMany({
      model: "definition",
      where: [
        { field: "source_id", value: sourceId },
        { field: "scope_id", value: scopeId },
      ],
    });
    yield* core.delete({
      model: "source",
      where: [
        { field: "id", value: sourceId },
        { field: "scope_id", value: scopeId },
      ],
    });
  });

const writeDefinitions = (
  core: TypedAdapter<CoreSchema>,
  pluginId: string,
  input: DefinitionsInput,
): Effect.Effect<void, StorageFailure> =>
  Effect.gen(function* () {
    // Pin the delete to `input.scope` — without this, the scoped
    // adapter's `scope_id IN (stack)` injection would nuke definitions
    // at outer scopes whenever an inner-scope writer re-registers
    // definitions for the same source id.
    yield* core.deleteMany({
      model: "definition",
      where: [
        { field: "source_id", value: input.sourceId },
        { field: "scope_id", value: input.scope },
      ],
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
    // Connection providers keyed by `provider.key` — drive the refresh
    // lifecycle for connection-owned tokens.
    const connectionProviders = new Map<string, ConnectionProvider>();
    // In-flight refresh dedup. `connectionsAccessToken` stamps a
    // `Deferred` here before calling the provider's `refresh`; parallel
    // callers that walk in while a refresh is still running observe
    // the same Deferred and await its resolution instead of hitting
    // the AS a second time. The map is mutated under a semaphore so
    // check-or-register is atomic under fiber interleavings.
    const refreshInFlight = new Map<
      string,
      Deferred.Deferred<
        string,
        | ConnectionNotFoundError
        | ConnectionProviderNotRegisteredError
        | ConnectionRefreshNotSupportedError
        | ConnectionReauthRequiredError
        | ConnectionRefreshError
        | StorageFailure
      >
    >();
    const refreshInFlightLock = Effect.unsafeMakeSemaphore(1);
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

    // Rank a row by how close its `scope_id` sits to the innermost scope.
    // Rows whose scope isn't in the stack get pushed to the end (they
    // shouldn't reach us — the adapter filters by `scope_id IN (stack)` —
    // but guarding here means a stray row can't silently win).
    const scopeRank = (row: { scope_id: unknown }) =>
      scopePrecedence.get(row.scope_id as string) ?? Infinity;

    // Pick the innermost-scope row on a findOne-by-id against a scoped
    // model. The scope-wrapped adapter returns rows from every scope in
    // the stack, so a bare `findOne({ id })` picks whichever one the
    // storage backend iterates first — non-deterministic across backends,
    // and wrong when a user has shadowed an outer default. Callers that
    // need a single logical row (invoke, tool schema, source removal)
    // must go through this path so the innermost write always wins.
    const findInnermost = <T extends { scope_id: unknown }>(
      rows: readonly T[],
    ): T | null => {
      if (rows.length === 0) return null;
      let winner: T | undefined;
      let best = Infinity;
      for (const row of rows) {
        const rank = scopeRank(row);
        if (rank < best) {
          best = rank;
          winner = row;
        }
      }
      return winner ?? null;
    };

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
        // caller-named scope. Pin the delete to `scope_id = input.scope`
        // — without it, the scoped adapter's `scope_id IN (stack)`
        // injection would wipe rows at outer scopes too, so any member
        // writing a personal override could delete admin-written
        // org-wide secrets with the same id.
        const now = new Date();
        yield* core.delete({
          model: "secret",
          where: [
            { field: "id", value: input.id },
            { field: "scope_id", value: input.scope },
          ],
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

    const secretsRemove = (
      id: string,
    ): Effect.Effect<void, SecretOwnedByConnectionError | StorageFailure> =>
      Effect.gen(function* () {
        // Remove is shadowing-aware: drop only the innermost-scope row.
        // Removing a user-scope override on a secret that also has an
        // org-scope default should reveal the org default, not wipe it.
        //
        // Without this, a regular member calling `secrets.remove("api_key")`
        // at their inner scope would cascade through `scope_id IN (stack)`
        // and delete the admin-written org row too.
        const rows = yield* core.findMany({
          model: "secret",
          where: [{ field: "id", value: id }],
        });
        const target = findInnermost(rows);
        // Refuse to delete connection-owned secrets. The connection owns
        // the lifecycle — callers must go through connections.remove.
        if (target && target.owned_by_connection_id) {
          return yield* Effect.fail(
            new SecretOwnedByConnectionError({
              secretId: SecretId.make(id),
              connectionId: ConnectionId.make(
                target.owned_by_connection_id as string,
              ),
            }),
          );
        }
        const targetScope = (target?.scope_id as string | undefined) ??
          scopeIds[0]!;

        const deleters = [...secretProviders.values()].filter(
          (p): p is typeof p & { delete: NonNullable<typeof p.delete> } =>
            !!(p.writable && p.delete),
        );
        yield* Effect.all(
          deleters.map((p) => p.delete(id, targetScope)),
          { concurrency: "unbounded" },
        );

        if (target) {
          yield* core.delete({
            model: "secret",
            where: [
              { field: "id", value: id },
              { field: "scope_id", value: targetScope },
            ],
          });
        }
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
        // precedence order (innermost first). Rows owned by a
        // connection are filtered out — the user sees the Connection
        // entry, not its backing token secrets. Their ids go in a
        // deny-set so provider `list()` results for the same id can't
        // leak them back in below.
        const allRows = yield* core.findMany({ model: "secret" });
        const connectionOwnedIds = new Set(
          allRows
            .filter((r) => r.owned_by_connection_id)
            .map((r) => r.id as string),
        );
        const rows = allRows.filter((r) => !r.owned_by_connection_id);
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
            if (connectionOwnedIds.has(entry.id)) continue; // hidden by connection
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
    // Connections facade — sign-in state as a first-class primitive.
    // Connection rows own one or more backing `secret` rows via
    // `secret.owned_by_connection_id`; the SDK orchestrates refresh via
    // the registered provider keyed by `connection.provider`.
    // ------------------------------------------------------------------

    // Refresh skew: treat the access token as "about to expire" when
    // we're within this many ms of the expiry the AS declared.
    // Matches the value the old per-plugin refresh code used, so
    // behavior under the new SDK orchestration stays identical.
    const CONNECTION_REFRESH_SKEW_MS = 60_000;

    const decodeProviderState = Schema.decodeUnknownOption(
      ConnectionProviderState,
    );

    const rowToConnection = (row: ConnectionRow): ConnectionRef =>
      new ConnectionRef({
        id: ConnectionId.make(row.id as string),
        scopeId: ScopeId.make(row.scope_id as string),
        provider: row.provider as string,
        identityLabel: (row.identity_label as string | null | undefined) ?? null,
        accessTokenSecretId: SecretId.make(row.access_token_secret_id as string),
        refreshTokenSecretId:
          row.refresh_token_secret_id != null
            ? SecretId.make(row.refresh_token_secret_id as string)
            : null,
        expiresAt:
          row.expires_at != null ? Number(row.expires_at as number) : null,
        oauthScope: (row.scope as string | null | undefined) ?? null,
        providerState: Option.getOrNull(
          decodeProviderState(decodeJsonColumn(row.provider_state)),
        ),
        createdAt:
          row.created_at instanceof Date
            ? row.created_at
            : new Date(row.created_at as string),
        updatedAt:
          row.updated_at instanceof Date
            ? row.updated_at
            : new Date(row.updated_at as string),
      });

    const findInnermostConnectionRow = (
      id: string,
    ): Effect.Effect<ConnectionRow | null, StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* core.findMany({
          model: "connection",
          where: [{ field: "id", value: id }],
        });
        return findInnermost(rows as readonly ConnectionRow[]);
      });

    const connectionsGet = (
      id: string,
    ): Effect.Effect<ConnectionRef | null, StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findInnermostConnectionRow(id);
        return row ? rowToConnection(row) : null;
      });

    const connectionsList = (): Effect.Effect<
      readonly ConnectionRef[],
      StorageFailure
    > =>
      Effect.gen(function* () {
        const rows = yield* core.findMany({ model: "connection" });
        // Dedup by id, innermost scope wins — same rule as sources/tools.
        const byId = new Map<string, ConnectionRow>();
        const byIdRank = new Map<string, number>();
        for (const row of rows as readonly ConnectionRow[]) {
          const rank = scopeRank(row as { scope_id: unknown });
          const existing = byIdRank.get(row.id as string);
          if (existing === undefined || rank < existing) {
            byId.set(row.id as string, row);
            byIdRank.set(row.id as string, rank);
          }
        }
        return [...byId.values()].map(rowToConnection);
      });

    // Write a secret value through a specific provider, bypassing the
    // bare-secrets ownership check so the SDK can stamp
    // `owned_by_connection_id` atomically alongside a connection row.
    const writeOwnedSecret = (
      params: {
        id: string;
        scope: string;
        name: string;
        value: string;
        provider: string;
        ownedByConnectionId: string;
      },
    ): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        const target = secretProviders.get(params.provider);
        if (!target) {
          return yield* Effect.fail(
            new StorageError({
              message: `Unknown secret provider: ${params.provider}`,
              cause: undefined,
            }),
          );
        }
        if (!target.writable || !target.set) {
          return yield* Effect.fail(
            new StorageError({
              message: `Secret provider "${target.key}" is read-only`,
              cause: undefined,
            }),
          );
        }
        yield* target.set(params.id, params.value, params.scope);

        const now = new Date();
        yield* core.delete({
          model: "secret",
          where: [
            { field: "id", value: params.id },
            { field: "scope_id", value: params.scope },
          ],
        });
        yield* core.create({
          model: "secret",
          data: {
            id: params.id,
            scope_id: params.scope,
            name: params.name,
            provider: target.key,
            owned_by_connection_id: params.ownedByConnectionId,
            created_at: now,
          },
          forceAllowId: true,
        });
      });

    const pickWritableProvider = (
      requested?: string,
    ): Effect.Effect<SecretProvider, StorageFailure> =>
      Effect.gen(function* () {
        if (requested) {
          const p = secretProviders.get(requested);
          if (!p) {
            return yield* Effect.fail(
              new StorageError({
                message: `Unknown secret provider: ${requested}`,
                cause: undefined,
              }),
            );
          }
          return p;
        }
        for (const p of secretProviders.values()) {
          if (p.writable && p.set) return p;
        }
        return yield* Effect.fail(
          new StorageError({
            message: "No writable secret providers registered",
            cause: undefined,
          }),
        );
      });

    const connectionsCreate = (
      input: CreateConnectionInput,
    ): Effect.Effect<
      ConnectionRef,
      ConnectionProviderNotRegisteredError | StorageFailure
    > =>
      Effect.gen(function* () {
        if (!scopeIds.includes(input.scope as string)) {
          return yield* Effect.fail(
            new StorageError({
              message:
                `connections.create targets scope "${input.scope}" which is not ` +
                `in the executor's scope stack [${scopeIds.join(", ")}].`,
              cause: undefined,
            }),
          );
        }
        if (!connectionProviders.has(input.provider)) {
          return yield* Effect.fail(
            new ConnectionProviderNotRegisteredError({
              provider: input.provider,
              connectionId: input.id,
            }),
          );
        }

        const writable = yield* pickWritableProvider();
        const now = new Date();

        return yield* adapter.transaction(() =>
          Effect.gen(function* () {
            // Drop any existing connection row at this scope first so a
            // re-auth replaces cleanly. Owned-secret rows for the old
            // connection are removed by the cascade below (we delete
            // both old + new token secret ids explicitly).
            yield* core.delete({
              model: "connection",
              where: [
                { field: "id", value: input.id as string },
                { field: "scope_id", value: input.scope as string },
              ],
            });

            yield* writeOwnedSecret({
              id: input.accessToken.secretId as string,
              scope: input.scope as string,
              name: input.accessToken.name,
              value: input.accessToken.value,
              provider: writable.key,
              ownedByConnectionId: input.id as string,
            });
            if (input.refreshToken) {
              yield* writeOwnedSecret({
                id: input.refreshToken.secretId as string,
                scope: input.scope as string,
                name: input.refreshToken.name,
                value: input.refreshToken.value,
                provider: writable.key,
                ownedByConnectionId: input.id as string,
              });
            }

            yield* core.create({
              model: "connection",
              data: {
                id: input.id as string,
                scope_id: input.scope as string,
                provider: input.provider,
                identity_label: input.identityLabel ?? undefined,
                access_token_secret_id: input.accessToken.secretId as string,
                refresh_token_secret_id:
                  input.refreshToken?.secretId ?? undefined,
                expires_at: input.expiresAt ?? undefined,
                scope: input.oauthScope ?? undefined,
                provider_state: input.providerState ?? undefined,
                created_at: now,
                updated_at: now,
              },
              forceAllowId: true,
            });

            return new ConnectionRef({
              id: input.id,
              scopeId: input.scope,
              provider: input.provider,
              identityLabel: input.identityLabel,
              accessTokenSecretId: input.accessToken.secretId,
              refreshTokenSecretId:
                input.refreshToken?.secretId ?? null,
              expiresAt: input.expiresAt,
              oauthScope: input.oauthScope,
              providerState: input.providerState,
              createdAt: now,
              updatedAt: now,
            });
          }),
        );
      });

    // Write new token material into the existing secret rows and bump
    // the connection row's expiry / scope / providerState. Never
    // mutates `access_token_secret_id` or `refresh_token_secret_id` —
    // those stay pinned so consumers that stashed them in source
    // configs still resolve.
    const connectionsUpdateTokens = (
      input: UpdateConnectionTokensInput,
    ): Effect.Effect<
      ConnectionRef,
      ConnectionNotFoundError | StorageFailure
    > =>
      Effect.gen(function* () {
        const row = yield* findInnermostConnectionRow(input.id as string);
        if (!row) {
          return yield* Effect.fail(
            new ConnectionNotFoundError({ connectionId: input.id }),
          );
        }
        const writable = yield* pickWritableProvider();
        const accessName =
          `Connection ${input.id as string} access token`;
        const refreshName =
          `Connection ${input.id as string} refresh token`;

        return yield* adapter.transaction(() =>
          Effect.gen(function* () {
            yield* writeOwnedSecret({
              id: row.access_token_secret_id as string,
              scope: row.scope_id as string,
              name: accessName,
              value: input.accessToken,
              provider: writable.key,
              ownedByConnectionId: row.id as string,
            });
            const rotatedRefresh = input.refreshToken ?? undefined;
            if (
              rotatedRefresh &&
              row.refresh_token_secret_id
            ) {
              yield* writeOwnedSecret({
                id: row.refresh_token_secret_id as string,
                scope: row.scope_id as string,
                name: refreshName,
                value: rotatedRefresh,
                provider: writable.key,
                ownedByConnectionId: row.id as string,
              });
            }
            const now = new Date();
            const patch: Record<string, unknown> = { updated_at: now };
            if (input.expiresAt !== undefined)
              patch.expires_at = input.expiresAt ?? undefined;
            if (input.oauthScope !== undefined)
              patch.scope = input.oauthScope ?? undefined;
            if (input.providerState !== undefined)
              patch.provider_state = input.providerState ?? undefined;
            if (input.identityLabel !== undefined)
              patch.identity_label = input.identityLabel ?? undefined;
            yield* core.update({
              model: "connection",
              where: [
                { field: "id", value: row.id as string },
                { field: "scope_id", value: row.scope_id as string },
              ],
              update: patch,
            });
            const updated = yield* findInnermostConnectionRow(
              row.id as string,
            );
            if (!updated) {
              return yield* Effect.fail(
                new ConnectionNotFoundError({ connectionId: input.id }),
              );
            }
            return rowToConnection(updated);
          }),
        );
      });

    const connectionsSetIdentityLabel = (
      id: string,
      label: string | null,
    ): Effect.Effect<void, ConnectionNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findInnermostConnectionRow(id);
        if (!row) {
          return yield* Effect.fail(
            new ConnectionNotFoundError({
              connectionId: ConnectionId.make(id),
            }),
          );
        }
        yield* core.update({
          model: "connection",
          where: [
            { field: "id", value: id },
            { field: "scope_id", value: row.scope_id as string },
          ],
          update: {
            identity_label: label ?? undefined,
            updated_at: new Date(),
          },
        });
      });

    const connectionsRemove = (
      id: string,
    ): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findInnermostConnectionRow(id);
        if (!row) return;
        const scope = row.scope_id as string;
        yield* adapter.transaction(() =>
          Effect.gen(function* () {
            // Find every owned secret at this scope and drop through
            // its provider + the core row. We look up by
            // `owned_by_connection_id` rather than just the two ids on
            // the connection row so any accidentally-orphaned siblings
            // get cleaned up too.
            const owned = yield* core.findMany({
              model: "secret",
              where: [
                { field: "owned_by_connection_id", value: id },
                { field: "scope_id", value: scope },
              ],
            });
            const deleters = [...secretProviders.values()].filter(
              (p): p is typeof p & { delete: NonNullable<typeof p.delete> } =>
                !!(p.writable && p.delete),
            );
            for (const secret of owned) {
              yield* Effect.all(
                deleters.map((p) => p.delete(secret.id as string, scope)),
                { concurrency: "unbounded" },
              );
            }
            yield* core.deleteMany({
              model: "secret",
              where: [
                { field: "owned_by_connection_id", value: id },
                { field: "scope_id", value: scope },
              ],
            });
            yield* core.delete({
              model: "connection",
              where: [
                { field: "id", value: id },
                { field: "scope_id", value: scope },
              ],
            });
          }),
        );
      });

    // Typed error union that `connectionsAccessToken` and every helper
    // that participates in a refresh returns. Pulled out into a type
    // alias because it has to match the Deferred's channel exactly —
    // otherwise concurrent waiters and the leader diverge on the error
    // type.
    type AccessTokenError =
      | ConnectionNotFoundError
      | ConnectionProviderNotRegisteredError
      | ConnectionRefreshNotSupportedError
      | ConnectionReauthRequiredError
      | ConnectionRefreshError
      | StorageFailure;

    // The actual work of a single refresh cycle, factored out so the
    // concurrency gate (`connectionsAccessToken`) stays readable. Runs
    // for the fiber that wins the `refreshInFlight` race.
    const performRefresh = (
      ref: ConnectionRef,
    ): Effect.Effect<string, AccessTokenError> =>
      Effect.gen(function* () {
        const provider = connectionProviders.get(ref.provider);
        if (!provider) {
          return yield* Effect.fail(
            new ConnectionProviderNotRegisteredError({
              provider: ref.provider,
              connectionId: ref.id,
            }),
          );
        }
        if (!provider.refresh) {
          return yield* Effect.fail(
            new ConnectionRefreshNotSupportedError({
              connectionId: ref.id,
              provider: ref.provider,
            }),
          );
        }

        const refreshTokenValue = ref.refreshTokenSecretId
          ? yield* secretsGet(ref.refreshTokenSecretId as unknown as string)
          : null;

        // RFC 6749 §5.2 `invalid_grant` (and anything else the
        // provider tags with `reauthRequired`) is terminal — the
        // stored refresh token can't recover. Translate into the
        // caller-visible "re-authenticate" error so the UI can
        // prompt sign-in instead of silently retrying.
        const rawResult = yield* Effect.either(
          provider.refresh({
            connectionId: ref.id,
            scopeId: ref.scopeId,
            identityLabel: ref.identityLabel,
            refreshToken: refreshTokenValue,
            providerState: ref.providerState,
            oauthScope: ref.oauthScope,
          }),
        );
        if (rawResult._tag === "Left") {
          const err = rawResult.left;
          if (err.reauthRequired) {
            return yield* Effect.fail(
              new ConnectionReauthRequiredError({
                connectionId: err.connectionId,
                provider: ref.provider,
                message: err.message,
              }),
            );
          }
          return yield* Effect.fail(err);
        }
        const result = rawResult.right;

        yield* connectionsUpdateTokens({
          id: ref.id,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
          oauthScope: result.oauthScope,
          providerState: result.providerState,
        } as UpdateConnectionTokensInput);

        return result.accessToken;
      });

    // accessToken(id) — the single surface plugins use at invoke time.
    // Resolves the backing secret, checks expiry, calls the provider's
    // refresh handler if we're inside the skew window. New tokens are
    // written back through the same provider and the connection row is
    // patched with the new expiry.
    //
    // Concurrent invokes on an expired token all share one refresh.
    // The fiber that wins the `refreshInFlightLock` race registers a
    // Deferred and performs the refresh; every other concurrent caller
    // observes the Deferred and awaits its completion. The Deferred is
    // pulled out of the map before the refresh result resolves so
    // later invokes don't reuse a completed slot.
    const connectionsAccessToken = (
      id: string,
    ): Effect.Effect<string, AccessTokenError> =>
      Effect.gen(function* () {
        const row = yield* findInnermostConnectionRow(id);
        if (!row) {
          return yield* Effect.fail(
            new ConnectionNotFoundError({
              connectionId: ConnectionId.make(id),
            }),
          );
        }
        const ref = rowToConnection(row);
        const now = Date.now();
        const needsRefresh =
          ref.expiresAt !== null &&
          ref.expiresAt - CONNECTION_REFRESH_SKEW_MS <= now;

        if (!needsRefresh) {
          const current = yield* secretsGet(
            ref.accessTokenSecretId as unknown as string,
          );
          if (current !== null) return current;
          // Fall through to refresh if the stored token vanished — a
          // genuinely-missing secret with no way to refresh is a
          // hard-failure, same behavior as if `expires_at` had passed.
        }

        // Concurrency gate. `action` either returns the fresh access
        // token (this fiber did the refresh) or the already-running
        // Deferred that another fiber stamped into the map (this fiber
        // piggybacks on their refresh).
        const action = yield* refreshInFlightLock.withPermits(1)(
          Effect.gen(function* () {
            const existing = refreshInFlight.get(id);
            if (existing) {
              return {
                kind: "await" as const,
                deferred: existing,
              };
            }
            const deferred = yield* Deferred.make<string, AccessTokenError>();
            refreshInFlight.set(id, deferred);
            return { kind: "lead" as const, deferred };
          }),
        );

        if (action.kind === "await") {
          return yield* action.deferred;
        }

        // Leader path: run the refresh, pipe the outcome into the
        // Deferred (so waiters wake up), and then clear the map slot
        // regardless of success or failure. Keeping clear+complete in
        // the same `onExit` avoids a window where a late waiter sees
        // the Deferred after it's been completed but before it's been
        // evicted.
        return yield* performRefresh(ref).pipe(
          Effect.onExit((exit) =>
            refreshInFlightLock.withPermits(1)(
              Effect.gen(function* () {
                refreshInFlight.delete(id);
                yield* Deferred.done(action.deferred, exit);
              }),
            ),
          ),
        );
      });

    const connectionsListForCtx = () => connectionsList();

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
              // `unregister` is scoped to a specific source row — look up
              // its scope before deleting so the tool/definition sweep
              // only touches rows at that scope. Walk the full stack and
              // pick the innermost-scope shadow so an inner-scope caller
              // can't accidentally (via non-deterministic findOne
              // iteration order) unregister the outer-scope source and
              // wipe a bystander's data at the same time.
              adapter.transaction(() =>
                Effect.gen(function* () {
                  const rows = yield* core.findMany({
                    model: "source",
                    where: [{ field: "id", value: sourceId }],
                  });
                  const row = findInnermost(rows);
                  if (!row) return;
                  yield* deleteSourceById(
                    core,
                    sourceId,
                    row.scope_id as string,
                  );
                }),
              ),
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
        connections: {
          get: (id) => connectionsGet(id),
          list: () => connectionsListForCtx(),
          create: (input) => connectionsCreate(input),
          updateTokens: (input) => connectionsUpdateTokens(input),
          setIdentityLabel: (id, label) =>
            connectionsSetIdentityLabel(id, label),
          accessToken: (id) => connectionsAccessToken(id),
          remove: (id) => connectionsRemove(id),
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

      if (plugin.connectionProviders) {
        const raw =
          typeof plugin.connectionProviders === "function"
            ? plugin.connectionProviders(ctx)
            : plugin.connectionProviders;
        const providers = Effect.isEffect(raw) ? yield* raw : raw;
        for (const provider of providers) {
          if (connectionProviders.has(provider.key)) {
            return yield* Effect.fail(
              new Error(
                `Duplicate connection provider key: ${provider.key} (from plugin ${plugin.id})`,
              ),
            );
          }
          connectionProviders.set(provider.key, provider);
        }
      }
    }

    // ------------------------------------------------------------------
    // Executor surface
    // ------------------------------------------------------------------
    const listSources = () =>
      Effect.gen(function* () {
        const dynamic = yield* core.findMany({ model: "source" });
        // Dedup by id with innermost scope winning. Without this, a user
        // who shadowed an org-wide source at their inner scope would see
        // two rows — their override and the outer default — which is
        // inconsistent with how `secrets.list` and every other list
        // surface dedup shadowed entries.
        const byId = new Map<string, typeof dynamic[number]>();
        const byIdRank = new Map<string, number>();
        for (const row of dynamic) {
          const rank = scopeRank(row);
          const existing = byIdRank.get(row.id);
          if (existing === undefined || rank < existing) {
            byId.set(row.id, row);
            byIdRank.set(row.id, rank);
          }
        }
        const dynamicDeduped = [...byId.values()];
        const staticList: Source[] = [];
        for (const { source, pluginId } of staticSources.values()) {
          staticList.push(staticDeclToSource(source, pluginId));
        }
        const merged = [...staticList, ...dynamicDeduped.map(rowToSource)];
        yield* Effect.annotateCurrentSpan({
          "executor.sources.static_count": staticList.length,
          "executor.sources.dynamic_count": dynamicDeduped.length,
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

        // Each (plugin_id, source_id) group is an independent DB read,
        // so fan them out concurrently. Yielding them serially stacks
        // ~200-300ms storage round-trips end-to-end and dominates the
        // `executor.tools.list.annotations` span.
        const maps = yield* Effect.forEach(
          [...groups],
          ([key, groupRows]) =>
            Effect.gen(function* () {
              const [pluginId, sourceId] = key.split("\u0000") as [
                string,
                string,
              ];
              const runtime = runtimes.get(pluginId);
              if (!runtime?.plugin.resolveAnnotations) return undefined;
              return yield* runtime.plugin.resolveAnnotations({
                ctx: runtime.ctx,
                sourceId,
                toolRows: groupRows,
              });
            }),
          { concurrency: "unbounded" },
        );
        for (const map of maps) {
          if (!map) continue;
          for (const [toolId, annotations] of Object.entries(map)) {
            result.set(toolId, annotations);
          }
        }
        return result;
      });

    const listTools = (filter?: ToolListFilter) =>
      Effect.gen(function* () {
        const dynamic = yield* core.findMany({
          model: "tool",
          where: filter?.sourceId
            ? [{ field: "source_id", value: filter.sourceId }]
            : undefined,
        });
        // Dedup by tool id, innermost scope winning — same reason as
        // `listSources` above: a shadowed id must surface as one entry
        // (the inner one), not two.
        const byId = new Map<string, typeof dynamic[number]>();
        const byIdRank = new Map<string, number>();
        for (const row of dynamic) {
          const rank = scopeRank(row);
          const existing = byIdRank.get(row.id);
          if (existing === undefined || rank < existing) {
            byId.set(row.id, row);
            byIdRank.set(row.id, rank);
          }
        }
        const dynamicDeduped = [...byId.values()];
        const annotations =
          filter?.includeAnnotations === false
            ? new Map<string, ToolAnnotations>()
            : yield* resolveAnnotationsFor(dynamicDeduped).pipe(
                Effect.withSpan("executor.tools.list.annotations"),
              );

        const out: Tool[] = [];
        // Static tools — annotations from the declaration, not a resolver.
        for (const entry of staticTools.values()) {
          out.push(staticDeclToTool(entry.source, entry.tool, entry.pluginId));
        }
        for (const row of dynamicDeduped) {
          out.push(rowToTool(row, annotations.get(row.id)));
        }
        const result = filter ? out.filter((t) => toolMatchesFilter(t, filter)) : out;
        yield* Effect.annotateCurrentSpan({
          "executor.tools.static_count": staticTools.size,
          "executor.tools.dynamic_count": dynamicDeduped.length,
          "executor.tools.result_count": result.length,
        });
        return result;
      }).pipe(Effect.withSpan("executor.tools.list"));

    // Load all definitions for a single source as a plain map. Defs
    // for the same name can exist at multiple scopes (an admin registers
    // a default, a user overrides one entry with a tighter schema) —
    // dedup by name keeping the innermost-scope row.
    const loadDefinitionsForSource = (sourceId: string) =>
      Effect.gen(function* () {
        const defRows = yield* core.findMany({
          model: "definition",
          where: [{ field: "source_id", value: sourceId }],
        });
        const winners = new Map<string, { row: typeof defRows[number]; rank: number }>();
        for (const row of defRows) {
          const rank = scopeRank(row);
          const existing = winners.get(row.name);
          if (!existing || rank < existing.rank) {
            winners.set(row.name, { row, rank });
          }
        }
        const out: Record<string, unknown> = {};
        for (const [name, { row }] of winners) out[name] = row.schema;
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
        // Innermost-wins lookup: the scope-wrapped adapter returns rows
        // from every scope in the stack, so a bare findOne would pick the
        // first row the backend iterates. That's wrong when a user has
        // shadowed an outer-scope tool — they'd get the outer schema
        // back instead of their override.
        const rows = yield* core
          .findMany({
            model: "tool",
            where: [{ field: "id", value: toolId }],
          })
          .pipe(Effect.withSpan("executor.tool.resolve"));
        const row = findInnermost(rows);
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
    // in-memory group-by with innermost-scope dedup: if the same
    // (source_id, name) pair exists at multiple scopes, the inner
    // scope's schema wins.
    const toolsDefinitions = () =>
      Effect.gen(function* () {
        const rows = yield* core.findMany({ model: "definition" });
        const winners = new Map<string, { row: typeof rows[number]; rank: number }>();
        for (const row of rows) {
          const key = `${row.source_id}\u0000${row.name}`;
          const rank = scopeRank(row);
          const existing = winners.get(key);
          if (!existing || rank < existing.rank) {
            winners.set(key, { row, rank });
          }
        }
        const out: Record<string, Record<string, unknown>> = {};
        for (const { row } of winners.values()) {
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

        // Dynamic path — DB lookup + delegate to owning plugin. Walk
        // the whole scope stack and pick the innermost-scope row so a
        // user's shadow of an outer tool actually wins on invoke (a bare
        // findOne would pick whatever row the backend iterated first).
        const toolRows = yield* core
          .findMany({
            model: "tool",
            where: [{ field: "id", value: toolId }],
          })
          .pipe(Effect.withSpan("executor.tool.resolve"));
        const row = findInnermost(toolRows);
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
        // Innermost-wins lookup — same reason as ctx.sources.unregister:
        // a caller with a stack that straddles two scopes must target
        // their own shadow, not the outer scope's row.
        const sourceRows = yield* core.findMany({
          model: "source",
          where: [{ field: "id", value: sourceId }],
        });
        const sourceRow = findInnermost(sourceRows);
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
                scope: sourceRow.scope_id as string,
              });
            }
            yield* deleteSourceById(
              core,
              sourceId,
              sourceRow.scope_id as string,
            );
          }),
        );
      });

    const refreshSource = (sourceId: string) =>
      Effect.gen(function* () {
        if (staticSources.has(sourceId)) return;
        // Innermost-wins: refresh the caller's shadow, not an outer-scope
        // source that happens to share an id.
        const sourceRows = yield* core.findMany({
          model: "source",
          where: [{ field: "id", value: sourceId }],
        });
        const sourceRow = findInnermost(sourceRows);
        if (!sourceRow) return;
        const runtime = runtimes.get(sourceRow.plugin_id);
        if (runtime?.plugin.refreshSource) {
          yield* runtime.plugin.refreshSource({
            ctx: runtime.ctx,
            sourceId,
            scope: sourceRow.scope_id as string,
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
      connections: {
        get: connectionsGet,
        list: connectionsList,
        create: connectionsCreate,
        updateTokens: connectionsUpdateTokens,
        setIdentityLabel: connectionsSetIdentityLabel,
        accessToken: connectionsAccessToken,
        remove: connectionsRemove,
        providers: () =>
          Effect.sync(
            () =>
              Array.from(connectionProviders.keys()) as readonly string[],
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
