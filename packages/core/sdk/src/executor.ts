import { Deferred, Duration, Effect, Layer, Option, Result, Semaphore } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { withQueryContext } from "fumadb/query";
import type { OAuthEndpointUrlPolicy } from "./oauth-helpers";
import {
  StorageError,
  makeFumaClient,
  type FumaDb,
  type FumaTables,
  type StorageFailure,
} from "./fuma-runtime";

import { makeFumaBlobStore, pluginBlobStore } from "./blob";
import {
  ConnectionRef,
  ConnectionRefreshError,
  type ConnectionProvider,
  type ConnectionRefreshResult,
  type CreateConnectionInput,
  type RemoveConnectionInput,
  type UpdateConnectionTokensInput,
} from "./connections";
import { type CredentialBindingsFacade } from "./credential-bindings";
import {
  type ConnectionRow,
  type DefinitionsInput,
  type SecretRow,
  type SourceInput,
  type SourceRow,
} from "./core-schema";
import {
  ElicitationDeclinedError,
  ElicitationResponse,
  type ElicitationHandler,
} from "./elicitation";
import {
  ConnectionInUseError,
  ConnectionNotFoundError,
  ConnectionProviderNotRegisteredError,
  ConnectionReauthRequiredError,
  ConnectionRefreshNotSupportedError,
  NoHandlerError,
  PluginNotLoadedError,
  SecretInUseError,
  SecretOwnedByConnectionError,
  SourceRemovalNotAllowedError,
  ToolBlockedError,
  ToolInvocationError,
  ToolNotFoundError,
} from "./errors";
import { ConnectionId, ScopeId, SecretId } from "./ids";
import { makeOAuth2Service } from "./oauth-service";
import type { OAuthService } from "./oauth";
import {
  type CreateToolPolicyInput,
  type PolicyMatch,
  type RemoveToolPolicyInput,
  type ToolPolicy,
  type UpdateToolPolicyInput,
} from "./policies";
import type {
  AnyPlugin,
  PluginCtx,
  PluginExtensions,
  StaticSourceDecl,
  StaticToolDecl,
  StorageDeps,
} from "./plugin";
import type { Scope } from "./scope";
import { RemoveSecretInput, SecretRef, SetSecretInput, type SecretProvider } from "./secrets";
import { Usage } from "./usages";
import {
  ToolSchema,
  type RefreshSourceInput,
  type RemoveSourceInput,
  type Source,
  type SourceDetectionResult,
  type Tool,
  type ToolListFilter,
} from "./types";
import type { ExecutorScopePolicyContext } from "./scope-policy";
import { makeCredentialBindings } from "./executor-credential-bindings";
import { makeExecutorSurface } from "./executor-surface";
import {
  EXECUTOR_SOURCE,
  EXECUTOR_SOURCE_ID,
  byId,
  byScopedId,
  collectTables,
  createDefaultMemoryDb,
  decodeJsonColumn,
  decodeProviderState,
  deleteSourceById,
  makeCoreDb,
  pluginStorageFailure,
  scopedWhere,
  storageFailureFromUnknown,
  validateExecutorDbTables,
  validateExecutorScopePolicyTables,
  writeDefinitions,
  writeSourceInput,
} from "./executor-helpers";

// ---------------------------------------------------------------------------
// Elicitation handler — set once at `createExecutor({ onElicitation })`
// and threaded into every tool invocation. A tool that requests user
// input mid-execution suspends the fiber and the handler decides how to
// respond. Tools that never elicit simply don't trigger the handler.
//
// The "accept-all" sentinel is convenient for tests and CLI automation —
// every elicitation request gets auto-accepted with an empty content
// payload. For real interactive hosts, pass a real handler.
//
// Required at the executor level rather than per-invoke, so the
// "what if a caller forgot to pass a handler" branch is structurally
// impossible. Higher layers that need per-invocation handler control
// (an MCP server bridging different per-client handlers, the execution
// engine threading agent-loop callbacks) can pass an override via
// `tools.invoke(id, args, { onElicitation })` — the executor-level
// handler is the fallback, never null.
// ---------------------------------------------------------------------------

export type OnElicitation = ElicitationHandler | "accept-all";

export interface InvokeOptions {
  /** Override the executor-level handler for this single call. */
  readonly onElicitation?: OnElicitation;
}

const acceptAllHandler: ElicitationHandler = () =>
  Effect.succeed(ElicitationResponse.make({ action: "accept" }));

const resolveElicitationHandler = (onElicitation: OnElicitation): ElicitationHandler =>
  onElicitation === "accept-all" ? acceptAllHandler : onElicitation;

// ---------------------------------------------------------------------------
// Executor — public surface. Every list/invoke/schema call is a direct
// core-table query (for dynamic rows) unioned with the in-memory static
// pool. No ToolRegistry, no SourceRegistry, no SecretStore services.
// ---------------------------------------------------------------------------

export type Executor<TPlugins extends readonly AnyPlugin[] = readonly []> = {
  /**
   * Precedence-ordered scope stack this executor was configured with.
   * Innermost first. Consumers that need "the display scope" typically
   * pick `scopes.at(-1)` (outermost, e.g. the organization) or
   * `scopes[0]` (innermost, e.g. the current user-in-org) depending on
   * what they're rendering.
   */
  readonly scopes: readonly Scope[];

  readonly tools: {
    readonly list: (filter?: ToolListFilter) => Effect.Effect<readonly Tool[], StorageFailure>;
    /** Fetch a tool's full schema view: JSON schemas with `$defs`
     *  attached from the core `definition` table, plus TypeScript
     *  preview strings rendered from them. Returns `null` for unknown
     *  tool ids. */
    readonly schema: (toolId: string) => Effect.Effect<ToolSchema | null, StorageFailure>;
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
      | ToolBlockedError
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
      input: RemoveSourceInput,
    ) => Effect.Effect<void, SourceRemovalNotAllowedError | StorageFailure>;
    readonly refresh: (input: RefreshSourceInput) => Effect.Effect<void, StorageFailure>;
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
    ) => Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure>;
    readonly getAtScope: (
      id: string,
      scope: string,
    ) => Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure>;
    /** Fast-path existence check — hits the core `secret` routing table
     *  only, never calls the provider. Use this for UI state ("secret
     *  missing, prompt to add") to avoid keychain permission prompts
     *  or 1password IPC roundtrips on a pre-flight check. */
    readonly status: (id: string) => Effect.Effect<"resolved" | "missing", StorageFailure>;
    readonly set: (input: SetSecretInput) => Effect.Effect<SecretRef, StorageFailure>;
    /** Delete a bare (non-connection-owned) secret. Connection-owned
     *  secrets are rejected with `SecretOwnedByConnectionError` — use
     *  `connections.remove` instead. Refuses with `SecretInUseError`
     *  if any plugin reports the secret as in use; the caller should
     *  show the `usages(id)` list and ask the user to detach first. */
    readonly remove: (
      input: RemoveSecretInput,
    ) => Effect.Effect<void, SecretOwnedByConnectionError | SecretInUseError | StorageFailure>;
    readonly list: () => Effect.Effect<readonly SecretRef[], StorageFailure>;
    /** Management view of visible secret rows. Unlike `list`, this does
     *  not collapse same-id rows across scopes, so UI that writes exact
     *  credential targets can show both personal and shared rows. */
    readonly listAll: () => Effect.Effect<readonly SecretRef[], StorageFailure>;
    /** All places this secret is referenced — fans out across every
     *  plugin's `usagesForSecret`. Used by the Secrets-tab "Used by"
     *  list and by `remove` for its RESTRICT check. */
    readonly usages: (id: string) => Effect.Effect<readonly Usage[], StorageFailure>;
    readonly providers: () => Effect.Effect<readonly string[]>;
  };

  readonly connections: {
    readonly get: (id: string) => Effect.Effect<ConnectionRef | null, StorageFailure>;
    readonly getAtScope: (
      id: string,
      scope: string,
    ) => Effect.Effect<ConnectionRef | null, StorageFailure>;
    readonly list: () => Effect.Effect<readonly ConnectionRef[], StorageFailure>;
    readonly create: (
      input: CreateConnectionInput,
    ) => Effect.Effect<ConnectionRef, ConnectionProviderNotRegisteredError | StorageFailure>;
    readonly updateTokens: (
      input: UpdateConnectionTokensInput,
    ) => Effect.Effect<ConnectionRef, ConnectionNotFoundError | StorageFailure>;
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
    readonly accessTokenAtScope: (
      id: string,
      scope: string,
    ) => Effect.Effect<
      string,
      | ConnectionNotFoundError
      | ConnectionProviderNotRegisteredError
      | ConnectionRefreshNotSupportedError
      | ConnectionReauthRequiredError
      | ConnectionRefreshError
      | StorageFailure
    >;
    /** Refuses with `ConnectionInUseError` if any plugin reports the
     *  connection as in use. */
    readonly remove: (
      input: RemoveConnectionInput,
    ) => Effect.Effect<void, ConnectionInUseError | StorageFailure>;
    /** All places this connection is referenced — fans out across every
     *  plugin's `usagesForConnection`. */
    readonly usages: (id: string) => Effect.Effect<readonly Usage[], StorageFailure>;
    readonly providers: () => Effect.Effect<readonly string[]>;
  };

  /** Shared credential slot bindings. Plugins decide what slot keys mean;
   *  core owns scoped storage, resolution status, and usage visibility. */
  readonly credentialBindings: CredentialBindingsFacade;

  /** Shared OAuth service. Hosts use this through the core HTTP OAuth group;
   *  plugins see the same service as `ctx.oauth`. */
  readonly oauth: OAuthService;

  readonly policies: {
    /** All policies visible across the executor's scope stack, sorted
     *  by (innermost-scope-first, position ascending) — i.e. the order
     *  in which they're evaluated by first-match-wins. */
    readonly list: () => Effect.Effect<readonly ToolPolicy[], StorageFailure>;
    /** Create a new policy. Defaults to the top of the target scope's
     *  list (highest precedence) when `position` is omitted. */
    readonly create: (input: CreateToolPolicyInput) => Effect.Effect<ToolPolicy, StorageFailure>;
    readonly update: (input: UpdateToolPolicyInput) => Effect.Effect<ToolPolicy, StorageFailure>;
    readonly remove: (input: RemoveToolPolicyInput) => Effect.Effect<void, StorageFailure>;
    /** Resolve the effective policy for a tool id by walking the scope-
     *  stacked policy list with first-match-wins semantics. Returns
     *  `undefined` when no rule matches (caller falls back to the
     *  plugin's `resolveAnnotations` output). */
    readonly resolve: (toolId: string) => Effect.Effect<PolicyMatch | undefined, StorageFailure>;
  };

  readonly close: () => Effect.Effect<void, StorageFailure>;
} & PluginExtensions<TPlugins>;

export interface ExecutorDb {
  readonly db: FumaDb<any>;
  readonly close?: () => Effect.Effect<void, StorageFailure> | Promise<void> | void;
}

export type ExecutorDbInput = FumaDb<any> | ExecutorDb;

export type ExecutorDbFactory = (config: {
  readonly tables: FumaTables;
}) => ExecutorDbInput | Effect.Effect<ExecutorDbInput, StorageFailure>;

export interface ExecutorConfig<TPlugins extends readonly AnyPlugin[] = readonly []> {
  /**
   * Precedence-ordered scope stack. Innermost first; typical shape is
   * `[userInOrgScope, orgScope]`. Reads on scoped tables walk the
   * stack (first hit wins for shadow-by-id consumers like secrets and
   * blobs); writes require callers to name an explicit target scope.
   * Must be non-empty.
   */
  readonly scopes: readonly Scope[];
  readonly db?: ExecutorDbInput | ExecutorDbFactory;
  readonly plugins?: TPlugins;
  /**
   * How to respond when a tool requests user input mid-invocation. Pass
   * `"accept-all"` for tests / non-interactive hosts, or a handler
   * `(ctx) => Effect<ElicitationResponse>` for interactive ones.
   * Required at construction so per-invoke calls don't have to thread
   * an options arg.
   */
  readonly onElicitation: OnElicitation;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly oauthEndpointUrlPolicy?: OAuthEndpointUrlPolicy;
  readonly sourceDetection?: {
    readonly maxUrlLength?: number;
    readonly maxDetectors?: number;
    readonly maxResults?: number;
    readonly timeout?: Duration.Input;
    readonly hostedOutboundPolicy?: boolean;
  };
}

export { collectTables };

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

export const createExecutor = <const TPlugins extends readonly AnyPlugin[] = readonly []>(
  config: ExecutorConfig<TPlugins>,
): Effect.Effect<Executor<TPlugins>, StorageFailure> =>
  Effect.gen(function* () {
    const defaultPlugins = (): TPlugins => {
      const empty: readonly AnyPlugin[] = [];
      return empty as TPlugins;
    };
    const { scopes, plugins = defaultPlugins() } = config;
    const tables = yield* Effect.try({
      try: () => collectTables(plugins),
      catch: (cause) => storageFailureFromUnknown("Failed to collect executor tables", cause),
    });
    const dbInput = yield* Effect.suspend((): Effect.Effect<ExecutorDbInput, StorageFailure> => {
      if (!config.db) return Effect.succeed(createDefaultMemoryDb(tables));
      if (typeof config.db !== "function") return Effect.succeed(config.db);
      const out = config.db({ tables });
      return Effect.isEffect(out) ? out : Effect.succeed(out);
    });
    const rootDbUntyped = "db" in dbInput ? dbInput.db : dbInput;
    const closeDb = "db" in dbInput ? dbInput.close : undefined;
    yield* Effect.try({
      try: () => {
        validateExecutorDbTables(tables, rootDbUntyped.internal.tables);
        validateExecutorScopePolicyTables(rootDbUntyped.internal.tables);
      },
      catch: (cause) => storageFailureFromUnknown("Failed to validate executor tables", cause),
    });

    if (scopes.length === 0) {
      return yield* new StorageError({
        message: "createExecutor requires a non-empty scopes array",
        cause: undefined,
      });
    }

    const scopeIds = scopes.map((s) => String(s.id));
    const rootDb = withQueryContext(rootDbUntyped, {
      allowedScopeIds: new Set(scopeIds),
    } satisfies ExecutorScopePolicyContext);
    const fuma = makeFumaClient(rootDb);
    const core = makeCoreDb(fuma);
    const blobs = makeFumaBlobStore(fuma);
    const transaction = <A, E>(effect: Effect.Effect<A, E>) => fuma.transaction(effect);

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
    const resolveConnectionProvider = (key: string): ConnectionProvider | undefined =>
      connectionProviders.get(key);
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
    const refreshInFlightLock = Semaphore.makeUnsafe(1);
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
    // should only arrive through explicit scope predicates, but guarding here
    // means a stray row can't silently win).
    const rowScopeId = (row: { readonly scope_id: unknown }) =>
      typeof row.scope_id === "string" ? row.scope_id : null;
    const scopeRank = (row: { readonly scope_id: unknown }) => {
      const scopeId = rowScopeId(row);
      return scopeId === null ? Infinity : (scopePrecedence.get(scopeId) ?? Infinity);
    };

    // Pick the innermost-scope row from a scoped Fuma query. Callers that
    // need one logical row query the whole visible scope stack and resolve
    // shadowing here.
    const findInnermost = <T extends { scope_id: unknown }>(rows: readonly T[]): T | null => {
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

    const filterUsagesToScopeStack = (usages: readonly Usage[]): readonly Usage[] =>
      usages.filter((usage) => scopeIds.includes(usage.scopeId));

    const secretRowsForId = (id: string): Effect.Effect<readonly SecretRow[], StorageFailure> =>
      core.findMany("secret", { where: scopedWhere(scopeIds, byId(id)) }) as Effect.Effect<
        readonly SecretRow[],
        StorageFailure
      >;

    const resolveSecretValueFromRows = (
      id: string,
      rows: readonly SecretRow[],
    ): Effect.Effect<string | null, StorageFailure> =>
      Effect.gen(function* () {
        const ordered = [...rows].sort((a, b) => scopeRank(a) - scopeRank(b));
        for (const row of ordered) {
          const provider = secretProviders.get(row.provider);
          if (!provider) continue;
          const value = yield* provider.get(id, row.scope_id);
          if (value !== null) return value;
        }

        // Fallback: ask enumerating providers in registration order. First
        // non-null wins. Providers that throw
        // are treated as "don't have it" so one flaky provider can't
        // block resolution via others. Scope-partitioning providers
        // get asked at the innermost scope as a display default — the
        // enumeration fallback doesn't know which scope the value
        // lives in; flat providers ignore the arg.
        const fallbackScope = scopeIds[0]!;
        const candidates = [...secretProviders.values()].filter(
          (p) => p.list && p.allowFallback !== false,
        );
        for (const provider of candidates) {
          const value = yield* provider
            .get(id, fallbackScope)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (value !== null) return value;
        }
        return null;
      });

    const secretsGet = (
      id: string,
    ): Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure> =>
      Effect.gen(function* () {
        // Connection-owned token rows are internal plumbing; public secret
        // resolution must not expose them even if a token secret id is leaked.
        const rows = yield* secretRowsForId(id);
        const owned = rows.find((row) => row.owned_by_connection_id);
        const ownedByConnectionId = owned?.owned_by_connection_id;
        if (ownedByConnectionId) {
          return yield* new SecretOwnedByConnectionError({
            secretId: SecretId.make(id),
            connectionId: ConnectionId.make(ownedByConnectionId),
          });
        }
        return yield* resolveSecretValueFromRows(id, rows);
      });

    const secretsGetResolved = (
      id: string,
    ): Effect.Effect<
      { readonly value: string; readonly scopeId: string | null } | null,
      StorageFailure
    > =>
      Effect.gen(function* () {
        const rows = yield* secretRowsForId(id);
        const ordered = [...rows].sort((a, b) => scopeRank(a) - scopeRank(b));
        for (const row of ordered) {
          if (row.owned_by_connection_id) continue;
          const value = yield* resolveSecretValueAtScope(row, id);
          if (value !== null) return { value, scopeId: row.scope_id };
        }
        const value = yield* resolveSecretValueFromRows(id, []);
        return value === null ? null : { value, scopeId: null };
      });

    const resolveSecretValueAtScope = (
      row: SecretRow | null,
      id: string,
    ): Effect.Effect<string | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!row) return null;
        const provider = secretProviders.get(row.provider);
        if (!provider) return null;
        return yield* provider.get(id, row.scope_id);
      });

    const secretsGetAtScope = (
      id: string,
      scope: string,
    ): Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure> =>
      Effect.gen(function* () {
        yield* assertScopeInStack("secret get scope", scope);
        const row = yield* findSecretRowAtScope({
          secretId: id,
          scopeId: scope,
        });
        if (row?.owned_by_connection_id) {
          return yield* new SecretOwnedByConnectionError({
            secretId: SecretId.make(id),
            connectionId: ConnectionId.make(row.owned_by_connection_id),
          });
        }
        return yield* resolveSecretValueAtScope(row, id);
      });

    const connectionSecretGetAtScope = (
      id: string,
      scope: string,
    ): Effect.Effect<string | null, StorageFailure> =>
      Effect.gen(function* () {
        yield* assertScopeInStack("connection secret get scope", scope);
        const row = yield* findSecretRowAtScope({
          secretId: id,
          scopeId: scope,
        });
        return yield* resolveSecretValueAtScope(row, id);
      });

    const secretRouteHasBackingValue = (row: SecretRow) => {
      const provider = secretProviders.get(row.provider);
      if (!provider?.has) return Effect.succeed(true);
      return provider.has(row.id, row.scope_id).pipe(Effect.catch(() => Effect.succeed(false)));
    };

    const secretsSet = (input: SetSecretInput): Effect.Effect<SecretRef, StorageFailure> =>
      Effect.gen(function* () {
        // Validate the write target before we touch the provider.
        if (!scopeIds.includes(input.scope)) {
          return yield* new StorageError({
            message:
              `secrets.set targets scope "${input.scope}" which is not ` +
              `in the executor's scope stack [${scopeIds.join(", ")}].`,
            cause: undefined,
          });
        }

        // Pick provider: explicit or first-writable. Misconfiguration
        // (unknown provider, no writable provider, read-only provider)
        // is a host setup bug — surface as `StorageError` so it lands
        // as a captured InternalError(traceId) at the SDK boundary.
        let target: SecretProvider | undefined;
        if (input.provider) {
          target = secretProviders.get(input.provider);
          if (!target) {
            return yield* new StorageError({
              message: `Unknown secret provider: ${input.provider}`,
              cause: undefined,
            });
          }
        } else {
          for (const provider of secretProviders.values()) {
            if (provider.writable && provider.set) {
              target = provider;
              break;
            }
          }
          if (!target) {
            return yield* new StorageError({
              message: "No writable secret providers registered",
              cause: undefined,
            });
          }
        }
        if (!target.writable || !target.set) {
          return yield* new StorageError({
            message: `Secret provider "${target.key}" is read-only`,
            cause: undefined,
          });
        }

        yield* target.set(input.id, input.value, input.scope);

        // Upsert metadata row in the core `secret` table at the
        // caller-named scope. Pin the delete to `scope_id = input.scope`
        // so a personal override never deletes an org-wide secret with
        // the same id.
        const now = new Date();
        yield* core.deleteMany("secret", {
          where: byScopedId(input.scope, input.id),
        });
        yield* core.create("secret", {
          id: input.id,
          scope_id: input.scope,
          name: input.name,
          provider: target.key,
          owned_by_connection_id: null,
          created_at: now,
        });

        return SecretRef.make({
          id: input.id,
          scopeId: input.scope,
          name: input.name,
          provider: target.key,
          createdAt: now,
        });
      });

    // Fan out across every plugin that contributes `usagesForSecret`. Each
    // plugin queries its own normalized columns with explicit scope filters.
    //
    // The display path (`secretsUsages` / `connectionsUsages` from the API)
    // calls `*Lenient`: per-plugin errors become a logWarning so one buggy
    // plugin can't break the UI footer. The delete RESTRICT path
    // (`secretsRemove` / `connectionsRemove`) calls `*Strict`: per-plugin
    // errors fail the whole call so a transient plugin failure can't be
    // mistaken for "no usages" and let through a delete that creates
    // dangling refs.
    const secretsUsagesStrict = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const secretId = SecretId.make(id);
        const coreUsages = yield* credentialBindingUsagesForSecret(id);
        const perPlugin = yield* Effect.all(
          [...runtimes.values()]
            .filter((r) => r.plugin.usagesForSecret)
            .map((r) =>
              r.plugin.usagesForSecret!({
                ctx: r.ctx,
                args: { secretId },
              }).pipe(
                Effect.mapError(
                  (cause): StorageFailure =>
                    new StorageError({
                      message: `usagesForSecret failed for plugin ${r.plugin.id}`,
                      cause,
                    }),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );
        return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
      });

    const secretsUsages = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const secretId = SecretId.make(id);
        const coreUsages = yield* credentialBindingUsagesForSecret(id);
        const perPlugin = yield* Effect.all(
          [...runtimes.values()]
            .filter((r) => r.plugin.usagesForSecret)
            .map((r) =>
              r.plugin.usagesForSecret!({
                ctx: r.ctx,
                args: { secretId },
              }).pipe(
                Effect.catchCause((cause: unknown) =>
                  Effect.logWarning(`usagesForSecret failed for plugin ${r.plugin.id}`, cause).pipe(
                    Effect.as([] as readonly Usage[]),
                  ),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );
        return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
      });

    const connectionsUsagesStrict = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const connectionId = ConnectionId.make(id);
        const coreUsages = yield* credentialBindingUsagesForConnection(id);
        const perPlugin = yield* Effect.all(
          [...runtimes.values()]
            .filter((r) => r.plugin.usagesForConnection)
            .map((r) =>
              r.plugin.usagesForConnection!({
                ctx: r.ctx,
                args: { connectionId },
              }).pipe(
                Effect.mapError(
                  (cause): StorageFailure =>
                    new StorageError({
                      message: `usagesForConnection failed for plugin ${r.plugin.id}`,
                      cause,
                    }),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );
        return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
      });

    const connectionsUsages = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
      Effect.gen(function* () {
        const connectionId = ConnectionId.make(id);
        const coreUsages = yield* credentialBindingUsagesForConnection(id);
        const perPlugin = yield* Effect.all(
          [...runtimes.values()]
            .filter((r) => r.plugin.usagesForConnection)
            .map((r) =>
              r.plugin.usagesForConnection!({
                ctx: r.ctx,
                args: { connectionId },
              }).pipe(
                Effect.catchCause((cause: unknown) =>
                  Effect.logWarning(
                    `usagesForConnection failed for plugin ${r.plugin.id}`,
                    cause,
                  ).pipe(Effect.as([] as readonly Usage[])),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        );
        return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
      });

    const secretsRemove = (
      input: RemoveSecretInput,
    ): Effect.Effect<void, SecretOwnedByConnectionError | SecretInUseError | StorageFailure> =>
      Effect.gen(function* () {
        const id = input.id;
        const targetScope = input.targetScope;
        if (!scopeIds.includes(targetScope)) {
          return yield* new StorageError({
            message:
              `secret remove targetScope "${targetScope}" is not in the executor's scope stack ` +
              `[${scopeIds.join(", ")}].`,
            cause: undefined,
          });
        }

        // Remove is target-scope aware: drop only the explicitly named
        // scope row. Removing a user-scope override on a secret that also
        // has an org-scope default should reveal the org default, not wipe
        // it. If no core row exists at the target scope, provider cleanup
        // is still scoped to the explicit target for provider-enumerated
        // secrets, but core metadata never falls through to an outer row.
        const rows = yield* core.findMany("secret", {
          where: scopedWhere(scopeIds, byId(id)),
        });
        const target = rows.find((row) => row.scope_id === targetScope);
        // Refuse to delete connection-owned secrets. The connection owns
        // the lifecycle — callers must go through connections.remove.
        if (target && target.owned_by_connection_id) {
          return yield* new SecretOwnedByConnectionError({
            secretId: SecretId.make(id),
            connectionId: ConnectionId.make(target.owned_by_connection_id),
          });
        }
        // RESTRICT: source/binding rows are pinned to the credential row's
        // scope. A same-id row in an outer scope does not satisfy a binding
        // written at the target scope, so the delete gate filters usages to
        // the exact row being removed.
        if (target) {
          const usages = (yield* secretsUsagesStrict(id)).filter(
            (usage) => usage.scopeId === targetScope,
          );
          if (usages.length > 0) {
            return yield* new SecretInUseError({
              secretId: SecretId.make(id),
              usageCount: usages.length,
            });
          }
        }

        const deleters = [...secretProviders.values()].filter(
          (p): p is typeof p & { delete: NonNullable<typeof p.delete> } =>
            !!(p.writable && p.delete),
        );
        yield* Effect.all(
          deleters.map((p) => p.delete(id, targetScope)),
          { concurrency: "unbounded" },
        );

        if (target) {
          yield* core.deleteMany("secret", {
            where: byScopedId(targetScope, id),
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
    // Multi-scope: core rows from any scope in the stack show up, each
    // tagged with its own `scope_id`. When the same id appears in multiple scopes, the
    // innermost wins — same rule as `secretsGet`. Provider-enumerated
    // entries don't know what scope they belong to and are attributed
    // to the innermost scope as a display default.
    const secretsList = (): Effect.Effect<readonly SecretRef[], StorageFailure> =>
      Effect.gen(function* () {
        const byId = new Map<string, SecretRef>();

        // Core routing rows first. Resolve collisions using the caller's
        // precedence order (innermost first). Rows owned by a connection
        // are filtered out — the user sees the Connection entry, not its
        // backing token secrets. Their ids go in a deny-set so provider
        // `list()` results for the same id can't leak them back in below.
        const allRows = yield* core.findMany("secret", { where: scopedWhere(scopeIds) });
        const rows = allRows.filter((r) => !r.owned_by_connection_id);
        const pick = (row: (typeof rows)[number]) => {
          const existing = byId.get(row.id);
          const incomingScope = row.scope_id;
          const incomingRank = scopeRank(row);
          if (existing) {
            const existingRank = scopePrecedence.get(existing.scopeId) ?? Infinity;
            if (existingRank <= incomingRank) return;
          }
          byId.set(
            row.id,
            SecretRef.make({
              id: SecretId.make(row.id),
              scopeId: ScopeId.make(incomingScope),
              name: row.name,
              provider: row.provider,
              createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
            }),
          );
        };
        for (const row of rows) {
          const hasBackingValue = yield* secretRouteHasBackingValue(row);
          if (hasBackingValue) pick(row);
        }

        // Don't let provider-enumerated entries resurrect ids that
        // belong to a connection-owned core row.
        const connectionOwnedIds = new Set(
          allRows.filter((r) => r.owned_by_connection_id).map((r) => r.id),
        );
        // Attribute provider-listed entries to the innermost scope as
        // a display default — providers like 1password and env don't
        // partition their inventory by executor scope.
        const innermostScopeId = scopeIds[0];
        if (innermostScopeId !== undefined) {
          for (const [key, provider] of secretProviders) {
            if (!provider.list) continue;
            const entries = yield* provider
              .list()
              .pipe(Effect.catch(() => Effect.succeed([] as const)));
            for (const entry of entries) {
              if (byId.has(entry.id)) continue;
              if (connectionOwnedIds.has(entry.id)) continue;
              byId.set(
                entry.id,
                SecretRef.make({
                  id: SecretId.make(entry.id),
                  scopeId: ScopeId.make(innermostScopeId),
                  name: entry.name,
                  provider: key,
                  createdAt: new Date(0),
                }),
              );
            }
          }
        }

        return Array.from(byId.values());
      });

    const secretsListAll = (): Effect.Effect<readonly SecretRef[], StorageFailure> =>
      Effect.gen(function* () {
        const allRows = yield* core.findMany("secret", { where: scopedWhere(scopeIds) });
        const coreIds = new Set<string>();
        const refs: SecretRef[] = [];

        for (const row of allRows) {
          coreIds.add(row.id);
          if (row.owned_by_connection_id) continue;
          const hasBackingValue = yield* secretRouteHasBackingValue(row);
          if (!hasBackingValue) continue;
          refs.push(
            SecretRef.make({
              id: SecretId.make(row.id),
              scopeId: ScopeId.make(row.scope_id),
              name: row.name,
              provider: row.provider,
              createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
            }),
          );
        }

        return refs.sort((a, b) => {
          const rank =
            (scopePrecedence.get(a.scopeId) ?? Infinity) -
            (scopePrecedence.get(b.scopeId) ?? Infinity);
          if (rank !== 0) return rank;
          const name = a.name.localeCompare(b.name);
          return name === 0 ? String(a.id).localeCompare(String(b.id)) : name;
        });
      });

    // Same union shape as secretsList but projected to the leaner
    // SecretListEntry shape that plugins get via ctx.secrets.list().
    const secretsListForCtx = () =>
      Effect.gen(function* () {
        const list = yield* secretsList();
        return list.map((ref) => ({
          id: String(ref.id),
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

    const rowToConnection = (row: ConnectionRow): ConnectionRef =>
      ConnectionRef.make({
        id: ConnectionId.make(row.id),
        scopeId: ScopeId.make(row.scope_id),
        provider: row.provider,
        identityLabel: row.identity_label ?? null,
        accessTokenSecretId: SecretId.make(row.access_token_secret_id),
        refreshTokenSecretId:
          row.refresh_token_secret_id != null ? SecretId.make(row.refresh_token_secret_id) : null,
        expiresAt: row.expires_at != null ? Number(row.expires_at) : null,
        oauthScope: row.scope ?? null,
        providerState: Option.getOrNull(decodeProviderState(decodeJsonColumn(row.provider_state))),
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
      });

    const findInnermostConnectionRow = (
      id: string,
    ): Effect.Effect<ConnectionRow | null, StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* core.findMany("connection", {
          where: scopedWhere(scopeIds, byId(id)),
        });
        return findInnermost(rows as readonly ConnectionRow[]);
      });

    const connectionsGet = (id: string): Effect.Effect<ConnectionRef | null, StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findInnermostConnectionRow(id);
        return row ? rowToConnection(row) : null;
      });

    const connectionsGetAtScope = (
      id: string,
      scope: string,
    ): Effect.Effect<ConnectionRef | null, StorageFailure> =>
      Effect.gen(function* () {
        yield* assertScopeInStack("connection get scope", scope);
        const row = yield* findConnectionRowAtScope({
          connectionId: id,
          scopeId: scope,
        });
        return row ? rowToConnection(row) : null;
      });

    const connectionsList = (): Effect.Effect<readonly ConnectionRef[], StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* core.findMany("connection", { where: scopedWhere(scopeIds) });
        // Dedup by id, innermost scope wins — same rule as sources/tools.
        const byId = new Map<string, ConnectionRow>();
        const byIdRank = new Map<string, number>();
        for (const row of rows as readonly ConnectionRow[]) {
          const rank = scopeRank(row);
          const existing = byIdRank.get(row.id);
          if (existing === undefined || rank < existing) {
            byId.set(row.id, row);
            byIdRank.set(row.id, rank);
          }
        }
        return [...byId.values()].map(rowToConnection);
      });

    // Write a secret value through a specific provider, bypassing the
    // bare-secrets ownership check so the SDK can stamp
    // `owned_by_connection_id` atomically alongside a connection row.
    const writeOwnedSecret = (params: {
      id: string;
      scope: string;
      name: string;
      value: string;
      provider: string;
      ownedByConnectionId: string;
    }): Effect.Effect<void, StorageFailure> =>
      Effect.gen(function* () {
        const target = secretProviders.get(params.provider);
        if (!target) {
          return yield* new StorageError({
            message: `Unknown secret provider: ${params.provider}`,
            cause: undefined,
          });
        }
        if (!target.writable || !target.set) {
          return yield* new StorageError({
            message: `Secret provider "${target.key}" is read-only`,
            cause: undefined,
          });
        }
        yield* target.set(params.id, params.value, params.scope);

        const now = new Date();
        yield* core.deleteMany("secret", {
          where: byScopedId(params.scope, params.id),
        });
        yield* core.create("secret", {
          id: params.id,
          scope_id: params.scope,
          name: params.name,
          provider: target.key,
          owned_by_connection_id: params.ownedByConnectionId,
          created_at: now,
        });
      });

    const pickWritableProvider = (
      requested?: string,
    ): Effect.Effect<SecretProvider, StorageFailure> =>
      Effect.gen(function* () {
        if (requested) {
          const p = secretProviders.get(requested);
          if (!p) {
            return yield* new StorageError({
              message: `Unknown secret provider: ${requested}`,
              cause: undefined,
            });
          }
          return p;
        }
        for (const p of secretProviders.values()) {
          if (p.writable && p.set) return p;
        }
        return yield* new StorageError({
          message: "No writable secret providers registered",
          cause: undefined,
        });
      });

    const connectionsCreate = (
      input: CreateConnectionInput,
    ): Effect.Effect<ConnectionRef, ConnectionProviderNotRegisteredError | StorageFailure> =>
      Effect.gen(function* () {
        if (!scopeIds.some((scopeId) => scopeId === input.scope)) {
          return yield* new StorageError({
            message:
              `connections.create targets scope "${input.scope}" which is not ` +
              `in the executor's scope stack [${scopeIds.join(", ")}].`,
            cause: undefined,
          });
        }
        if (!resolveConnectionProvider(input.provider)) {
          return yield* new ConnectionProviderNotRegisteredError({
            provider: input.provider,
            connectionId: input.id,
          });
        }

        const writable = yield* pickWritableProvider();
        const now = new Date();

        return yield* transaction(
          Effect.gen(function* () {
            // Drop any existing connection row at this scope first so a
            // re-auth replaces cleanly. Owned-secret rows for the old
            // connection are removed by the cascade below (we delete
            // both old + new token secret ids explicitly).
            yield* core.deleteMany("connection", {
              where: byScopedId(input.scope, input.id),
            });

            yield* writeOwnedSecret({
              id: input.accessToken.secretId,
              scope: input.scope,
              name: input.accessToken.name,
              value: input.accessToken.value,
              provider: writable.key,
              ownedByConnectionId: input.id,
            });
            if (input.refreshToken) {
              yield* writeOwnedSecret({
                id: input.refreshToken.secretId,
                scope: input.scope,
                name: input.refreshToken.name,
                value: input.refreshToken.value,
                provider: writable.key,
                ownedByConnectionId: input.id,
              });
            }

            yield* core.create("connection", {
              id: input.id,
              scope_id: input.scope,
              provider: input.provider,
              identity_label: input.identityLabel ?? null,
              access_token_secret_id: input.accessToken.secretId,
              refresh_token_secret_id: input.refreshToken?.secretId ?? null,
              expires_at: input.expiresAt ?? null,
              scope: input.oauthScope ?? null,
              provider_state: input.providerState ?? null,
              created_at: now,
              updated_at: now,
            });

            return ConnectionRef.make({
              id: input.id,
              scopeId: input.scope,
              provider: input.provider,
              identityLabel: input.identityLabel,
              accessTokenSecretId: input.accessToken.secretId,
              refreshTokenSecretId: input.refreshToken?.secretId ?? null,
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
    const connectionsUpdateTokensForRow = (
      input: UpdateConnectionTokensInput,
      row: ConnectionRow,
    ): Effect.Effect<ConnectionRef, ConnectionNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const writable = yield* pickWritableProvider();
        const accessName = `Connection ${input.id} access token`;
        const refreshName = `Connection ${input.id} refresh token`;

        return yield* transaction(
          Effect.gen(function* () {
            yield* writeOwnedSecret({
              id: row.access_token_secret_id,
              scope: row.scope_id,
              name: accessName,
              value: input.accessToken,
              provider: writable.key,
              ownedByConnectionId: row.id,
            });
            const rotatedRefresh = input.refreshToken ?? undefined;
            if (rotatedRefresh && row.refresh_token_secret_id) {
              yield* writeOwnedSecret({
                id: row.refresh_token_secret_id,
                scope: row.scope_id,
                name: refreshName,
                value: rotatedRefresh,
                provider: writable.key,
                ownedByConnectionId: row.id,
              });
            }
            const now = new Date();
            const patch: Record<string, unknown> = { updated_at: now };
            if (input.expiresAt !== undefined) patch.expires_at = input.expiresAt ?? null;
            if (input.oauthScope !== undefined) patch.scope = input.oauthScope ?? null;
            if (input.providerState !== undefined)
              patch.provider_state = input.providerState ?? null;
            if (input.identityLabel !== undefined)
              patch.identity_label = input.identityLabel ?? null;
            yield* core.updateMany("connection", {
              where: byScopedId(row.scope_id, row.id),
              set: patch,
            });
            const updated = yield* findConnectionRowAtScope({
              connectionId: row.id,
              scopeId: row.scope_id,
            });
            if (!updated) {
              return yield* new ConnectionNotFoundError({
                connectionId: input.id,
              });
            }
            return rowToConnection(updated);
          }),
        );
      });

    const connectionsUpdateTokens = (
      input: UpdateConnectionTokensInput,
    ): Effect.Effect<ConnectionRef, ConnectionNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findInnermostConnectionRow(input.id);
        if (!row) {
          return yield* new ConnectionNotFoundError({ connectionId: input.id });
        }
        return yield* connectionsUpdateTokensForRow(input, row);
      });

    const connectionsSetIdentityLabel = (
      id: string,
      label: string | null,
    ): Effect.Effect<void, ConnectionNotFoundError | StorageFailure> =>
      Effect.gen(function* () {
        const row = yield* findInnermostConnectionRow(id);
        if (!row) {
          return yield* new ConnectionNotFoundError({
            connectionId: ConnectionId.make(id),
          });
        }
        yield* core.updateMany("connection", {
          where: byScopedId(row.scope_id, id),
          set: {
            identity_label: label ?? null,
            updated_at: new Date(),
          },
        });
      });

    const connectionsRemove = (
      input: RemoveConnectionInput,
    ): Effect.Effect<void, ConnectionInUseError | StorageFailure> =>
      Effect.gen(function* () {
        const id = input.id;
        const targetScope = input.targetScope;
        yield* assertScopeInStack("connection remove targetScope", targetScope);
        const allRows = yield* core.findMany("connection", {
          where: scopedWhere(scopeIds, byId(id)),
        });
        const row =
          (allRows as readonly ConnectionRow[]).find(
            (candidate) => candidate.scope_id === targetScope,
          ) ?? null;
        if (!row) return;
        const usages = (yield* connectionsUsagesStrict(id)).filter(
          (usage) => usage.scopeId === targetScope,
        );
        if (usages.length > 0) {
          return yield* new ConnectionInUseError({
            connectionId: ConnectionId.make(id),
            usageCount: usages.length,
          });
        }
        const scope = targetScope;
        yield* transaction(
          Effect.gen(function* () {
            // Find every owned secret at this scope and drop through
            // its provider + the core row. We look up by
            // `owned_by_connection_id` rather than just the two ids on
            // the connection row so any accidentally-orphaned siblings
            // get cleaned up too.
            const owned = yield* core.findMany("secret", {
              where: (b) => b.and(b("owned_by_connection_id", "=", id), b("scope_id", "=", scope)),
            });
            const deleters = [...secretProviders.values()].filter(
              (p): p is typeof p & { delete: NonNullable<typeof p.delete> } =>
                !!(p.writable && p.delete),
            );
            for (const secret of owned) {
              yield* Effect.all(
                deleters.map((p) =>
                  p
                    .delete(secret.id, scope)
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          `Failed to delete connection-owned secret from provider ${p.key}`,
                          cause,
                        ).pipe(Effect.as(false)),
                      ),
                    ),
                ),
                { concurrency: "unbounded" },
              );
            }
            yield* core.deleteMany("secret", {
              where: (b) => b.and(b("owned_by_connection_id", "=", id), b("scope_id", "=", scope)),
            });
            yield* core.deleteMany("connection", {
              where: byScopedId(scope, id),
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
    const performRefresh = (ref: ConnectionRef): Effect.Effect<string, AccessTokenError> =>
      Effect.gen(function* () {
        const provider = resolveConnectionProvider(ref.provider);
        if (!provider) {
          return yield* new ConnectionProviderNotRegisteredError({
            provider: ref.provider,
            connectionId: ref.id,
          });
        }
        if (!provider.refresh) {
          return yield* new ConnectionRefreshNotSupportedError({
            connectionId: ref.id,
            provider: ref.provider,
          });
        }

        const refreshTokenValue = ref.refreshTokenSecretId
          ? yield* connectionSecretGetAtScope(ref.refreshTokenSecretId, ref.scopeId)
          : null;

        // RFC 6749 §5.2 `invalid_grant` (and anything else the
        // provider tags with `reauthRequired`) is terminal — the
        // stored refresh token can't recover. Translate into the
        // caller-visible "re-authenticate" error so the UI can
        // prompt sign-in instead of silently retrying.
        const rawResult: Result.Result<ConnectionRefreshResult, ConnectionRefreshError> =
          yield* Effect.result(
            provider.refresh({
              connectionId: ref.id,
              scopeId: ref.scopeId,
              identityLabel: ref.identityLabel,
              refreshToken: refreshTokenValue,
              providerState: ref.providerState,
              oauthScope: ref.oauthScope,
            }),
          );
        if (Result.isFailure(rawResult)) {
          const err = rawResult.failure;
          if (err.reauthRequired) {
            return yield* new ConnectionReauthRequiredError({
              connectionId: err.connectionId,
              provider: ref.provider,
              // oxlint-disable-next-line executor/no-unknown-error-message -- typed: ConnectionRefreshError.message is provider-facing domain data, not an unknown caught error
              message: err["message"],
            });
          }
          return yield* err;
        }
        const result = rawResult.success;

        const row = yield* findConnectionRowAtScope({
          connectionId: ref.id,
          scopeId: ref.scopeId,
        });
        if (!row) {
          return yield* new ConnectionNotFoundError({
            connectionId: ref.id,
          });
        }
        yield* connectionsUpdateTokensForRow(
          {
            id: ref.id,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresAt: result.expiresAt,
            oauthScope: result.oauthScope,
            providerState: result.providerState,
          } as UpdateConnectionTokensInput,
          row,
        );

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
    const connectionsAccessTokenForRow = (
      row: ConnectionRow,
    ): Effect.Effect<string, AccessTokenError> =>
      Effect.gen(function* () {
        const ref = rowToConnection(row);
        const now = Date.now();
        const needsRefresh =
          ref.expiresAt !== null && ref.expiresAt - CONNECTION_REFRESH_SKEW_MS <= now;

        if (!needsRefresh) {
          const current = yield* connectionSecretGetAtScope(ref.accessTokenSecretId, ref.scopeId);
          if (current !== null) return current;
          // Fall through to refresh if the stored token vanished — a
          // genuinely-missing secret with no way to refresh is a
          // hard-failure, same behavior as if `expires_at` had passed.
        }

        // Concurrency gate. `action` either returns the fresh access
        // token (this fiber did the refresh) or the already-running
        // Deferred that another fiber stamped into the map (this fiber
        // piggybacks on their refresh).
        const refreshKey = `${ref.scopeId}\u0000${ref.id}`;
        const action = yield* refreshInFlightLock.withPermits(1)(
          Effect.gen(function* () {
            const existing = refreshInFlight.get(refreshKey);
            if (existing) {
              return {
                kind: "await" as const,
                deferred: existing,
              };
            }
            const deferred = yield* Deferred.make<string, AccessTokenError>();
            refreshInFlight.set(refreshKey, deferred);
            return { kind: "lead" as const, deferred };
          }),
        );

        if (action.kind === "await") {
          return yield* Deferred.await(action.deferred);
        }

        // Leader path: run the refresh, pipe the outcome into the
        // Deferred (so waiters wake up), and then clear the map slot
        // regardless of success or failure. Completing before delete
        // ensures a caller that arrives during cleanup can still observe
        // the settled leader result instead of starting a second refresh.
        return yield* performRefresh(ref).pipe(
          Effect.onExit((exit) =>
            refreshInFlightLock.withPermits(1)(
              Effect.gen(function* () {
                yield* Deferred.done(action.deferred, exit);
                refreshInFlight.delete(refreshKey);
              }),
            ),
          ),
        );
      });

    const connectionsAccessToken = (id: string): Effect.Effect<string, AccessTokenError> =>
      Effect.gen(function* () {
        const row = yield* findInnermostConnectionRow(id);
        if (!row) {
          return yield* new ConnectionNotFoundError({
            connectionId: ConnectionId.make(id),
          });
        }
        return yield* connectionsAccessTokenForRow(row);
      });

    const connectionsAccessTokenAtScope = (
      id: string,
      scope: string,
    ): Effect.Effect<string, AccessTokenError> =>
      Effect.gen(function* () {
        yield* assertScopeInStack("connection accessToken scope", scope);
        const row = yield* findConnectionRowAtScope({
          connectionId: id,
          scopeId: scope,
        });
        if (!row) {
          return yield* new ConnectionNotFoundError({
            connectionId: ConnectionId.make(id),
          });
        }
        return yield* connectionsAccessTokenForRow(row);
      });

    const connectionsListForCtx = () => connectionsList();

    const scopeListLabel = () => `[${scopeIds.join(", ")}]`;

    const assertScopeInStack = (
      label: string,
      scopeId: string,
    ): Effect.Effect<void, StorageError> =>
      scopeIds.includes(scopeId)
        ? Effect.void
        : Effect.fail(
            new StorageError({
              message: `${label} "${scopeId}" is not in the executor's scope stack ${scopeListLabel()}.`,
              cause: undefined,
            }),
          );

    const findSourceRowAtScope = (input: {
      readonly pluginId: string;
      readonly sourceId: string;
      readonly sourceScope: string;
    }): Effect.Effect<SourceRow | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!scopeIds.includes(input.sourceScope)) return null;
        return yield* core.findFirst("source", {
          where: (b) =>
            b.and(
              b("plugin_id", "=", input.pluginId),
              b("id", "=", input.sourceId),
              b("scope_id", "=", input.sourceScope),
            ),
        });
      });

    const findSecretRowAtScope = (input: {
      readonly secretId: string;
      readonly scopeId: string;
    }): Effect.Effect<SecretRow | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!scopeIds.includes(input.scopeId)) return null;
        return yield* core.findFirst("secret", {
          where: byScopedId(input.scopeId, input.secretId),
        });
      });

    const findConnectionRowAtScope = (input: {
      readonly connectionId: string;
      readonly scopeId: string;
    }): Effect.Effect<ConnectionRow | null, StorageFailure> =>
      Effect.gen(function* () {
        if (!scopeIds.includes(input.scopeId)) return null;
        return yield* core.findFirst("connection", {
          where: byScopedId(input.scopeId, input.connectionId),
        });
      });

    const credentialBindings = makeCredentialBindings({
      core,
      scopeIds,
      scopePrecedence,
      scopeRank,
      findInnermost,
      assertScopeInStack,
      findSourceRowAtScope,
      findSecretRowAtScope,
      findConnectionRowAtScope,
      secretProviders,
      secretRouteHasBackingValue,
    });
    const credentialBindingUsagesForSecret = credentialBindings.usagesForSecret;
    const credentialBindingUsagesForConnection = credentialBindings.usagesForConnection;

    const oauthBundle = makeOAuth2Service({
      fuma,
      secretsGet: (id) =>
        secretsGet(id).pipe(
          Effect.catchTag("SecretOwnedByConnectionError", () => Effect.succeed(null)),
        ),
      secretsGetResolved: (id) => secretsGetResolved(id),
      secretsGetAtScope: (id, scope) =>
        secretsGetAtScope(id, scope).pipe(
          Effect.catchTag("SecretOwnedByConnectionError", () => Effect.succeed(null)),
        ),
      secretsSet: (input) => secretsSet(input),
      connectionsCreate: (input) => connectionsCreate(input),
      httpClientLayer: config.httpClientLayer,
      endpointUrlPolicy: config.oauthEndpointUrlPolicy,
    });
    connectionProviders.set(oauthBundle.connectionProvider.key, oauthBundle.connectionProvider);

    // ------------------------------------------------------------------
    // Plugin wiring — build ctx, run extension, populate static pools,
    // register secret providers. No adapter reads here.
    // ------------------------------------------------------------------
    for (const plugin of plugins) {
      if (runtimes.has(plugin.id)) {
        return yield* new StorageError({
          message: `Duplicate plugin id: ${plugin.id}`,
          cause: undefined,
        });
      }

      const pluginFuma = makeFumaClient(
        rootDb,
        plugin.schema ? { tables: new Set(Object.keys(plugin.schema)) } : { tables: new Set() },
      );
      const storageDeps: StorageDeps = {
        scopes,
        fuma: pluginFuma,
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
        httpClientLayer: config.httpClientLayer ?? FetchHttpClient.layer,
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
                  return yield* new StorageError({
                    message: `Source id "${input.id}" collides with a static source`,
                    cause: undefined,
                  });
                }
                for (const tool of input.tools) {
                  const fqid = `${input.id}.${tool.name}`;
                  if (staticTools.has(fqid)) {
                    return yield* new StorageError({
                      message: `Tool id "${fqid}" collides with a static tool`,
                      cause: undefined,
                    });
                  }
                }
                yield* transaction(writeSourceInput(core, plugin.id, input));
              }),
            unregister: (input: RemoveSourceInput) =>
              // `unregister` is scoped to a caller-named source row. The
              // plugin already knows which source owner it is updating,
              // so the core path must not infer an innermost target.
              transaction(
                Effect.gen(function* () {
                  yield* assertScopeInStack("source unregister targetScope", input.targetScope);
                  const row = yield* core.findFirst("source", {
                    where: byScopedId(input.targetScope, input.id),
                  });
                  if (!row) return;
                  yield* deleteSourceById(core, input.id, input.targetScope);
                }),
              ),
            update: (input) =>
              core
                .updateMany("source", {
                  where: byScopedId(input.scope, input.id),
                  set: {
                    ...(input.name !== undefined ? { name: input.name } : {}),
                    ...(input.url !== undefined ? { url: input.url ?? null } : {}),
                    updated_at: new Date(),
                  },
                })
                .pipe(Effect.asVoid),
          },
          definitions: {
            register: (input: DefinitionsInput) =>
              transaction(writeDefinitions(core, plugin.id, input)),
          },
        },
        secrets: {
          get: (id) => secretsGet(id),
          getAtScope: (id, scope) => secretsGetAtScope(id, scope),
          list: () => secretsListForCtx(),
          set: (input) => secretsSet(input),
          remove: (input) => secretsRemove(input),
        },
        connections: {
          get: (id) => connectionsGet(id),
          getAtScope: (id, scope) => connectionsGetAtScope(id, scope),
          list: () => connectionsListForCtx(),
          create: (input) => connectionsCreate(input),
          updateTokens: (input) => connectionsUpdateTokens(input),
          setIdentityLabel: (id, label) => connectionsSetIdentityLabel(id, label),
          accessToken: (id) => connectionsAccessToken(id),
          accessTokenAtScope: (id, scope) => connectionsAccessTokenAtScope(id, scope),
          remove: (input) => connectionsRemove(input),
        },
        credentialBindings,
        oauth: oauthBundle.service,
        transaction: <A, E>(effect: Effect.Effect<A, E>) => transaction(effect),
      };

      // Build extension FIRST so it's available as `self` when resolving
      // staticSources. Field ordering in the plugin spec matters — TS
      // infers TExtension from `extension`'s return type, then NoInfer
      // locks `self` to that inferred type on `staticSources`.
      const extension: object = plugin.extension ? plugin.extension(ctx) : {};
      if (plugin.extension) {
        extensions[plugin.id] = extension;
      }

      // Resolve static declarations to the in-memory pools. NO DB WRITES.
      // Plugin-owned executor tools are intentionally mounted under the
      // single `executor` namespace so source inventory is about configured
      // integrations, not plugin management surfaces:
      //   openapi.addSource -> executor.openapi.addSource
      const decls = plugin.staticSources ? plugin.staticSources(extension) : [];
      for (const source of decls) {
        const mountUnderExecutor = source.kind === "executor" && source.id === plugin.id;
        const mountedSource = mountUnderExecutor ? EXECUTOR_SOURCE : source;

        if (mountUnderExecutor) {
          if (!staticSources.has(EXECUTOR_SOURCE_ID)) {
            staticSources.set(EXECUTOR_SOURCE_ID, {
              source: EXECUTOR_SOURCE,
              pluginId: EXECUTOR_SOURCE_ID,
            });
          }
        } else {
          if (staticSources.has(source.id)) {
            return yield* new StorageError({
              message: `Duplicate static source id: ${source.id} (plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          staticSources.set(source.id, { source, pluginId: plugin.id });
        }

        for (const tool of source.tools) {
          const mountedTool = mountUnderExecutor
            ? {
                ...tool,
                name: `${plugin.id}.${tool.name}`,
              }
            : tool;
          const fqid = `${mountedSource.id}.${mountedTool.name}`;
          if (staticTools.has(fqid)) {
            return yield* new StorageError({
              message: `Duplicate static tool id: ${fqid} (plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          staticTools.set(fqid, {
            source: mountedSource,
            tool: mountedTool,
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
        const providers = Effect.isEffect(raw)
          ? yield* raw.pipe(
              Effect.mapError((cause) => pluginStorageFailure(plugin.id, "secretProviders", cause)),
            )
          : raw;
        for (const provider of providers) {
          if (secretProviders.has(provider.key)) {
            return yield* new StorageError({
              message: `Duplicate secret provider key: ${provider.key} (from plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          secretProviders.set(provider.key, provider);
        }
      }

      if (plugin.connectionProviders) {
        const raw =
          typeof plugin.connectionProviders === "function"
            ? plugin.connectionProviders(ctx)
            : plugin.connectionProviders;
        const providers = Effect.isEffect(raw)
          ? yield* raw.pipe(
              Effect.mapError((cause) =>
                pluginStorageFailure(plugin.id, "connectionProviders", cause),
              ),
            )
          : raw;
        for (const provider of providers) {
          if (connectionProviders.has(provider.key)) {
            return yield* new StorageError({
              message: `Duplicate connection provider key: ${provider.key} (from plugin ${plugin.id})`,
              cause: undefined,
            });
          }
          connectionProviders.set(provider.key, provider);
        }
      }
    }

    // ------------------------------------------------------------------
    // Executor surface
    // ------------------------------------------------------------------
    const executorSurface = makeExecutorSurface({
      core,
      scopeIds,
      scopeRank,
      findInnermost,
      staticTools,
      staticSources,
      runtimes,
      transaction,
      assertScopeInStack,
      onElicitation: config.onElicitation,
      resolveElicitationHandler,
      sourceDetection: config.sourceDetection,
      hostedOutboundPolicyDefault: config.httpClientLayer !== undefined,
    });
    const listSources = executorSurface.sources.list;
    const removeSource = executorSurface.sources.remove;
    const refreshSource = executorSurface.sources.refresh;
    const detectSource = executorSurface.sources.detect;
    const sourceDefinitions = executorSurface.sources.definitions;
    const listTools = executorSurface.tools.list;
    const toolSchema = executorSurface.tools.schema;
    const toolsDefinitions = executorSurface.tools.definitions;
    const invokeTool = executorSurface.tools.invoke;
    const policiesList = executorSurface.policies.list;
    const policiesCreate = executorSurface.policies.create;
    const policiesUpdate = executorSurface.policies.update;
    const policiesRemove = executorSurface.policies.remove;
    const policiesResolve = executorSurface.policies.resolve;

    // Existence check for user-facing secret pickers. Core `secret`
    // rows are routing metadata; when a provider can answer `has()`,
    // confirm the backing value still exists. Providers without `has()`
    // remain conservative so keychain/1password don't need to return
    // the value or prompt just to populate picker/status UI.
    const secretsStatus = (id: string): Effect.Effect<"resolved" | "missing", StorageFailure> =>
      Effect.gen(function* () {
        const rows = yield* secretRowsForId(id);
        if (rows.some((row) => row.owned_by_connection_id)) return "missing";
        for (const row of rows) {
          if (yield* secretRouteHasBackingValue(row)) return "resolved";
        }

        return "missing";
      });

    const close = () =>
      Effect.gen(function* () {
        for (const runtime of runtimes.values()) {
          if (runtime.plugin.close) {
            yield* runtime.plugin
              .close()
              .pipe(
                Effect.mapError((cause) => pluginStorageFailure(runtime.plugin.id, "close", cause)),
              );
          }
        }
        if (closeDb) {
          const out = closeDb();
          if (Effect.isEffect(out)) {
            yield* out;
          } else if (out instanceof Promise) {
            yield* Effect.tryPromise({
              try: () => out,
              catch: (cause) =>
                new StorageError({
                  message: "Executor database close failed",
                  cause,
                }),
            });
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
        getAtScope: secretsGetAtScope,
        status: secretsStatus,
        set: secretsSet,
        remove: secretsRemove,
        list: secretsList,
        listAll: secretsListAll,
        usages: secretsUsages,
        providers: () => Effect.sync(() => Array.from(secretProviders.keys()) as readonly string[]),
      },
      connections: {
        get: connectionsGet,
        getAtScope: connectionsGetAtScope,
        list: connectionsList,
        create: connectionsCreate,
        updateTokens: connectionsUpdateTokens,
        setIdentityLabel: connectionsSetIdentityLabel,
        accessToken: connectionsAccessToken,
        accessTokenAtScope: connectionsAccessTokenAtScope,
        remove: connectionsRemove,
        usages: connectionsUsages,
        providers: () =>
          Effect.sync(() => Array.from(connectionProviders.keys()) as readonly string[]),
      },
      credentialBindings,
      oauth: oauthBundle.service,
      policies: {
        list: policiesList,
        create: policiesCreate,
        update: policiesUpdate,
        remove: policiesRemove,
        resolve: policiesResolve,
      },
      close,
    };

    // Plugin extension keys are known from the generic plugin tuple,
    // while runtime registration builds the same shape dynamically.
    const toExecutor = (value: unknown): Executor<TPlugins> => value as Executor<TPlugins>;
    return toExecutor(Object.assign(base, extensions));
  });
