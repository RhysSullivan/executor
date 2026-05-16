import { Duration, Effect, Layer } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { withQueryContext } from "fumadb/query";
import type { OAuthEndpointUrlPolicy } from "./oauth-helpers";
import {
  StorageError,
  makeFumaClient,
  type FumaDb,
  type FumaTables,
  type StorageFailure,
} from "./fuma-runtime";

import { makeFumaBlobStore } from "./blob";
import {
  ConnectionRef,
  ConnectionRefreshError,
  type ConnectionProvider,
  type CreateConnectionInput,
  type RemoveConnectionInput,
  type UpdateConnectionTokensInput,
} from "./connections";
import { type CredentialBindingsFacade } from "./credential-bindings";
import { type ConnectionRow, type SecretRow, type SourceRow } from "./core-schema";
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
import { makeOAuth2Service } from "./oauth-service";
import type { OAuthService } from "./oauth";
import {
  type CreateToolPolicyInput,
  type PolicyMatch,
  type RemoveToolPolicyInput,
  type ToolPolicy,
  type UpdateToolPolicyInput,
} from "./policies";
import type { AnyPlugin, PluginExtensions } from "./plugin";
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
import { makeConnectionsFacade } from "./executor-connections";
import {
  registerExecutorPlugins,
  type ExecutorPluginRuntime,
  type ExecutorStaticSource,
  type ExecutorStaticTool,
} from "./executor-plugin-runtime";
import { makeSecretsFacade } from "./executor-secrets";
import { makeExecutorSurface } from "./executor-surface";
import {
  byScopedId,
  collectTables,
  createDefaultMemoryDb,
  makeCoreDb,
  pluginStorageFailure,
  storageFailureFromUnknown,
  validateExecutorDbTables,
  validateExecutorScopePolicyTables,
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
    const staticTools = new Map<string, ExecutorStaticTool>();
    const staticSources = new Map<string, ExecutorStaticSource>();

    // Per-plugin runtime state.
    const runtimes = new Map<string, ExecutorPluginRuntime>();
    // Secret providers keyed by `provider.key`.
    const secretProviders = new Map<string, SecretProvider>();
    // Connection providers keyed by `provider.key` — drive the refresh
    // lifecycle for connection-owned tokens.
    const connectionProviders = new Map<string, ConnectionProvider>();
    const extensions: Record<string, object> = {};

    // ------------------------------------------------------------------
    // Scoped row helpers.
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

    let credentialBindingUsagesForSecret: (
      id: string,
    ) => Effect.Effect<readonly Usage[], StorageFailure> = () => Effect.succeed([]);
    let credentialBindingUsagesForConnection: (
      id: string,
    ) => Effect.Effect<readonly Usage[], StorageFailure> = () => Effect.succeed([]);
    const secrets = makeSecretsFacade({
      core,
      scopeIds,
      scopePrecedence,
      scopeRank,
      secretProviders,
      runtimes,
      findSecretRowAtScope,
      assertScopeInStack,
      credentialBindingUsagesForSecret: (id) => credentialBindingUsagesForSecret(id),
      credentialBindingUsagesForConnection: (id) => credentialBindingUsagesForConnection(id),
    });
    const connectionsUsages = secrets.connectionsUsages;
    const connectionsUsagesStrict = secrets.connectionsUsagesStrict;
    const secretsGet = secrets.get;
    const secretsGetResolved = secrets.getResolved;
    const secretsGetAtScope = secrets.getAtScope;
    const connectionSecretGetAtScope = secrets.connectionSecretGetAtScope;
    const secretsSet = secrets.set;
    const secretsRemove = secrets.remove;
    const secretsList = secrets.list;
    const secretsListAll = secrets.listAll;
    const secretsListForCtx = secrets.listForCtx;
    const secretsUsages = secrets.usages;
    const secretsStatus = secrets.status;
    const secretRouteHasBackingValue = secrets.routeHasBackingValue;

    const connections = makeConnectionsFacade({
      core,
      scopeIds,
      scopeRank,
      findInnermost,
      assertScopeInStack,
      findConnectionRowAtScope,
      transaction,
      secretProviders,
      connectionProviders,
      connectionSecretGetAtScope,
      connectionsUsagesStrict,
    });
    const connectionsGet = connections.get;
    const connectionsGetAtScope = connections.getAtScope;
    const connectionsList = connections.list;
    const connectionsListForCtx = connections.listForCtx;
    const connectionsCreate = connections.create;
    const connectionsUpdateTokens = connections.updateTokens;
    const connectionsSetIdentityLabel = connections.setIdentityLabel;
    const connectionsAccessToken = connections.accessToken;
    const connectionsAccessTokenAtScope = connections.accessTokenAtScope;
    const connectionsRemove = connections.remove;

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
    credentialBindingUsagesForSecret = credentialBindings.usagesForSecret;
    credentialBindingUsagesForConnection = credentialBindings.usagesForConnection;

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

    yield* registerExecutorPlugins({
      plugins,
      scopes,
      rootDb,
      blobs,
      scopeIds,
      core,
      staticTools,
      staticSources,
      runtimes,
      secretProviders,
      connectionProviders,
      extensions,
      transaction,
      assertScopeInStack,
      httpClientLayer: config.httpClientLayer,
      secrets: {
        get: secretsGet,
        getAtScope: secretsGetAtScope,
        list: secretsListForCtx,
        set: secretsSet,
        remove: secretsRemove,
      },
      connections: {
        get: connectionsGet,
        getAtScope: connectionsGetAtScope,
        list: connectionsListForCtx,
        create: connectionsCreate,
        updateTokens: connectionsUpdateTokens,
        setIdentityLabel: connectionsSetIdentityLabel,
        accessToken: connectionsAccessToken,
        accessTokenAtScope: connectionsAccessTokenAtScope,
        remove: connectionsRemove,
      },
      credentialBindings,
      oauth: oauthBundle.service,
    });

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
