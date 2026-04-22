import type { Effect } from "effect";
import type {
  DBAdapter,
  DBSchema,
  StorageFailure,
  TypedAdapter,
} from "@executor/storage-core";

import type { PluginBlobStore } from "./blob";
import type {
  ConnectionProvider,
  ConnectionRef,
  ConnectionRefreshError,
  CreateConnectionInput,
  UpdateConnectionTokensInput,
} from "./connections";
import type {
  DefinitionsInput,
  SourceInput,
  ToolAnnotations,
  ToolRow,
} from "./core-schema";
import type { SourceDetectionResult } from "./types";
import type {
  ElicitationDeclinedError,
  ElicitationHandler,
  ElicitationRequest,
  ElicitationResponse,
} from "./elicitation";
import type {
  ConnectionNotFoundError,
  ConnectionProviderNotRegisteredError,
  ConnectionReauthRequiredError,
  ConnectionRefreshNotSupportedError,
  SecretOwnedByConnectionError,
} from "./errors";
import type { Scope } from "./scope";
import type { SecretProvider, SecretRef, SetSecretInput } from "./secrets";

// ---------------------------------------------------------------------------
// StorageDeps — backing passed to a plugin's `storage` factory. The only
// place a plugin ever sees storage; `PluginCtx` does not carry it. The
// `adapter` field is a `TypedAdapter<TSchema>` view narrowed by the
// plugin's own declared `schema` — plugins never import or construct
// a typed adapter themselves, the executor infers TSchema from the
// `schema` field on their spec and hands back a typed view.
//
// Plugins with no schema (secret-provider-only plugins, etc.) get a
// bare `DBAdapter` they can ignore.
// ---------------------------------------------------------------------------

export interface StorageDeps<TSchema extends DBSchema | undefined = undefined> {
  /**
   * Precedence-ordered scope stack visible to this executor. Innermost
   * first. Reads on scoped tables walk every scope; writes require the
   * plugin to name a target scope explicitly (via `scope_id` on the
   * adapter payload, via `options.scope` on the blob store).
   */
  readonly scopes: readonly Scope[];
  /**
   * Plugin-facing typed adapter. Failures surface as raw `StorageFailure`
   * (`StorageError` | `UniqueViolationError`). Plugins can
   * `catchTag("UniqueViolationError", …)` to translate to their own
   * user-facing errors. `StorageError` bubbles up; the HTTP edge (see
   * `@executor/api` `withCapture`) is the one place that
   * translates it to the opaque `InternalError({ traceId })`.
   */
  readonly adapter: TSchema extends DBSchema
    ? TypedAdapter<TSchema, StorageFailure>
    : DBAdapter;
  readonly blobs: PluginBlobStore;
}

// ---------------------------------------------------------------------------
// defineSchema — sugar around `as const satisfies DBSchema`. Preserves
// literal types via the `const` type parameter modifier so plugins can
// just write `const mySchema = defineSchema({ ... })` without annotation
// ceremony.
// ---------------------------------------------------------------------------

export const defineSchema = <const S extends DBSchema>(schema: S): S => schema;

// ---------------------------------------------------------------------------
// Elicit — suspends the fiber, calls the invoke-time elicitation
// handler, resumes with the user's response. Available on both static
// tool handlers and dynamic `invokeTool` handlers. Threaded through
// the executor from `tools.invoke(id, args, { onElicitation })`.
// ---------------------------------------------------------------------------

export type Elicit = (
  request: ElicitationRequest,
) => Effect.Effect<ElicitationResponse, ElicitationDeclinedError>;

// ---------------------------------------------------------------------------
// PluginCtx — threaded into every extension method, static tool handler,
// and dynamic tool handler. No raw adapter, no raw blobs. Core writes
// go through `core.sources.register` / `core.definitions.register`.
// ---------------------------------------------------------------------------

export interface PluginCtx<TStore = unknown> {
  /**
   * Precedence-ordered scope stack visible to this executor. Innermost
   * first. Plugins that write scoped rows must pick an element of
   * `scopes` as the `scope`/`scope_id` they stamp; reads through the
   * adapter or `ctx.secrets` automatically fall through the stack.
   */
  readonly scopes: readonly Scope[];
  readonly storage: TStore;

  readonly core: {
    readonly sources: {
      readonly register: (
        input: SourceInput,
      ) => Effect.Effect<void, StorageFailure>;
      readonly unregister: (
        sourceId: string,
      ) => Effect.Effect<void, StorageFailure>;
    };
    /** Register shared JSON-schema `$defs` for a source. Tool
     *  input/output schemas registered via `sources.register` can carry
     *  `$ref: "#/$defs/X"` pointers; `executor.tools.schema(toolId)`
     *  attaches matching defs to the returned schema. Call inside the
     *  same `ctx.transaction` as `sources.register` for atomicity.
     *  Replaces any existing defs for the given sourceId. */
    readonly definitions: {
      readonly register: (
        input: DefinitionsInput,
      ) => Effect.Effect<void, StorageFailure>;
    };
  };

  readonly secrets: {
    readonly get: (
      id: string,
    ) => Effect.Effect<string | null, StorageFailure>;
    /** List user-visible secrets. Connection-owned secrets (rows with
     *  `owned_by_connection_id` set) are filtered out so they don't
     *  clutter the UI — users see the Connection instead. */
    readonly list: () => Effect.Effect<
      readonly { readonly id: string; readonly name: string; readonly provider: string }[],
      StorageFailure
    >;
    /** Write a secret value through a provider. Used by plugins that
     *  mint secrets on behalf of the user (OAuth2 token storage,
     *  interactive onboarding flows). Normally writes go through
     *  `executor.secrets.set` on the host surface, but OAuth2 refresh
     *  and one-shot token capture from plugin-owned flows need it here
     *  too. Same routing rules as the host-level setter. */
    readonly set: (
      input: SetSecretInput,
    ) => Effect.Effect<SecretRef, StorageFailure>;
    /** Delete a secret from its pinned provider and the core table.
     *  Rejects with `SecretOwnedByConnectionError` if the row is owned
     *  by a connection — callers must go through `connections.remove`
     *  to drop the whole sign-in. */
    readonly remove: (
      id: string,
    ) => Effect.Effect<void, SecretOwnedByConnectionError | StorageFailure>;
  };

  /** Connections — product-level sign-in state. Owns backing secret
   *  rows via `secret.owned_by_connection_id`. Plugins call
   *  `connections.accessToken(id)` at invoke time to get a guaranteed-
   *  fresh token (the SDK handles refresh via the registered provider
   *  keyed by `connection.provider`). */
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
    /** Get a guaranteed-fresh access token. Calls the provider's
     *  `refresh` handler if `expires_at` is in the past / within the
     *  refresh skew window. */
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
  };

  /** Run `effect` inside a database transaction. Wraps the underlying
   *  adapter's transaction method. Use this in extension methods that
   *  need atomicity across plugin storage writes AND core source/tool
   *  registration. */
  readonly transaction: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | StorageFailure>;
}

// ---------------------------------------------------------------------------
// Static tool / source declarations. Pure data + handlers declared at
// plugin-definition time.
//
// Importantly, `StaticToolDecl.handler` does NOT reference TExtension.
// If it did, the nested generic would break inference for the whole
// PluginSpec (TS would fall back to the `object` constraint on TExtension).
// `self: NoInfer<TExtension>` lives on `staticSources` one level up
// instead, and plugin authors close over it via the arrow-function
// closure when they write their handler.
// ---------------------------------------------------------------------------

export interface StaticToolHandlerInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly args: unknown;
  /** Suspend the fiber to request user input. The handler passed to
   *  `executor.tools.invoke(..., { onElicitation })` is called. */
  readonly elicit: Elicit;
}

export interface StaticToolDecl<TStore = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  /** Default-policy annotations — `requiresApproval`, `approvalDescription`,
   *  `mayElicit`. Enforced by the executor before the handler runs.
   *  Inline because static tools have no plugin storage to resolve from;
   *  the plugin author literally writes this at definition time. */
  readonly annotations?: ToolAnnotations;
  readonly handler: (
    input: StaticToolHandlerInput<TStore>,
  ) => Effect.Effect<unknown, unknown>;
}

export interface StaticSourceDecl<TStore = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly url?: string;
  /** Static sources default to `canRemove: false` — they represent
   *  plugin-provided control surfaces and shouldn't be user-removable.
   *  Override only if you really want that. */
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
  readonly canEdit?: boolean;
  readonly tools: readonly StaticToolDecl<TStore>[];
}

// ---------------------------------------------------------------------------
// Dynamic invoke / source lifecycle inputs.
// ---------------------------------------------------------------------------

export interface InvokeToolInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  /** Already-loaded tool row. Plugin doesn't need to re-fetch or parse
   *  the tool id. Carries source_id, name, input/output schemas,
   *  annotations. */
  readonly toolRow: ToolRow;
  readonly args: unknown;
  /** Elicitation handle for plugins that need mid-invocation user input
   *  (onepassword auth prompt, interactive MCP tools, etc.). */
  readonly elicit: Elicit;
}

export interface SourceLifecycleInput<TStore = unknown> {
  readonly ctx: PluginCtx<TStore>;
  readonly sourceId: string;
  /**
   * Scope of the source row being removed/refreshed — resolved by the
   * SDK's `sources.remove` / `sources.refresh` via innermost-wins lookup
   * across the executor's scope stack. Plugins that own a side table
   * keyed by (id, scope_id) must pin their own cleanup to this scope;
   * relying on the scoped adapter's `scope_id IN (stack)` fall-through
   * would widen the mutation across the whole stack and wipe a
   * shadowed outer-scope row.
   */
  readonly scope: string;
}

// ---------------------------------------------------------------------------
// PluginSpec — what a `definePlugin(factory)` call returns.
// ---------------------------------------------------------------------------

export interface PluginSpec<
  TId extends string = string,
  TExtension extends object = Record<string, never>,
  TStore = unknown,
  TSchema extends DBSchema | undefined = DBSchema | undefined,
> {
  readonly id: TId;
  /** Plugin-declared schema. Merged with coreSchema and other plugins'
   *  schemas at executor startup via `collectSchemas`. The type flows
   *  into the `storage` factory's `deps.adapter` as a `TypedAdapter<TSchema>`
   *  so plugins get narrowed model names + typed rows for free. */
  readonly schema?: TSchema;
  /** Build the plugin's typed store from backing. `deps.adapter` is
   *  already narrowed to this plugin's schema; `deps.blobs` is already
   *  scoped to the plugin id so key collisions across plugins are
   *  structurally impossible. */
  readonly storage: (deps: StorageDeps<TSchema>) => TStore;

  /** Build the plugin's extension API. The returned object becomes
   *  `executor[plugin.id]` and is also the `self` passed to
   *  `staticSources`. Field order matters: `extension` MUST appear
   *  before `staticSources` so TS infers TExtension from this
   *  factory's return BEFORE type-checking `self: NoInfer<TExtension>`. */
  readonly extension?: (ctx: PluginCtx<TStore>) => TExtension;

  /** Static sources contributed by this plugin with inline tool
   *  handlers. Lives entirely in memory — no DB writes at startup.
   *  Handlers close over `self` via the closure, so a control tool
   *  that delegates to the plugin's real API is a one-liner:
   *  `({ args }) => self.addSpec(args)`. */
  readonly staticSources?: (
    self: NoInfer<TExtension>,
  ) => readonly StaticSourceDecl<TStore>[];

  /** Invoke a dynamic tool. Called when the executor's static-handler
   *  map doesn't have the toolId. The plugin reads its own enrichment
   *  via `ctx.storage` and returns the result. Optional — plugins with
   *  only static tools can omit it. */
  readonly invokeTool?: (
    input: InvokeToolInput<TStore>,
  ) => Effect.Effect<unknown, unknown>;

  /** Bulk resolve annotations (requiresApproval, approvalDescription,
   *  mayElicit) for a set of tool rows under a single source. Called
   *  by the executor:
   *    - at invoke time with a single-element `toolRows` array, to
   *      enforce approval on the about-to-run tool
   *    - at list time with every dynamic tool row under each source,
   *      grouped by source_id, to populate `Tool.annotations` for UI
   *
   *  The expected implementation for most plugins is: read plugin
   *  storage once for the given source/rows, derive annotations from
   *  the same data that was used to build the tool (HTTP method +
   *  path for openapi, introspection kind for graphql, etc.), return
   *  a map keyed by tool id.
   *
   *  Omit if the plugin has no annotations to contribute — executor
   *  treats tools from that plugin as auto-approved with no
   *  elicitation. */
  readonly resolveAnnotations?: (input: {
    readonly ctx: PluginCtx<TStore>;
    readonly sourceId: string;
    readonly toolRows: readonly ToolRow[];
  }) => Effect.Effect<Record<string, ToolAnnotations>, unknown>;

  /** Called when `executor.sources.remove(id)` targets a source owned
   *  by this plugin. Plugin-side cleanup only; the executor deletes
   *  the core source/tool rows after this callback returns, inside
   *  the same transaction. */
  readonly removeSource?: (
    input: SourceLifecycleInput<TStore>,
  ) => Effect.Effect<void, unknown>;

  readonly refreshSource?: (
    input: SourceLifecycleInput<TStore>,
  ) => Effect.Effect<void, unknown>;

  /** URL autodetection hook. When the user pastes a URL in the
   *  onboarding UI, `executor.sources.detect(url)` fans out to every
   *  plugin's `detect`. Return a `SourceDetectionResult` if you
   *  recognize the URL, `null` otherwise. Implementations should be
   *  defensive — swallow fetch errors and return null rather than
   *  throwing. First high-confidence match wins. */
  readonly detect?: (input: {
    readonly ctx: PluginCtx<TStore>;
    readonly url: string;
  }) => Effect.Effect<SourceDetectionResult | null, unknown>;

  /** Secret providers contributed by this plugin. Either a static
   *  array, a function of ctx (for providers that need per-instance
   *  state like the keychain's scope-derived service name), or a
   *  function returning an Effect so plugins can probe for backend
   *  availability at startup and register conditionally. Called once
   *  at executor startup after `storage` and `extension` have been
   *  built. */
  readonly secretProviders?:
    | readonly SecretProvider[]
    | ((ctx: PluginCtx<TStore>) => readonly SecretProvider[])
    | ((
        ctx: PluginCtx<TStore>,
      ) => Effect.Effect<readonly SecretProvider[]>);

  /** Connection providers contributed by this plugin. Same registration
   *  shape as `secretProviders`. Each provider's `key` is what
   *  `connection.provider` references in the core table; the `refresh`
   *  handler is the SDK's single entry point for token lifecycle —
   *  plugins don't run their own refresh loops anymore. */
  readonly connectionProviders?:
    | readonly ConnectionProvider[]
    | ((ctx: PluginCtx<TStore>) => readonly ConnectionProvider[])
    | ((
        ctx: PluginCtx<TStore>,
      ) => Effect.Effect<readonly ConnectionProvider[]>);

  readonly close?: () => Effect.Effect<void, unknown>;
}

export interface Plugin<
  TId extends string = string,
  TExtension extends object = Record<string, never>,
  TStore = unknown,
  TSchema extends DBSchema | undefined = DBSchema | undefined,
> extends PluginSpec<TId, TExtension, TStore, TSchema> {}

// ---------------------------------------------------------------------------
// definePlugin — factory-returning-spec. Options from the author factory
// are merged with a storage override so consumers can swap the default
// store implementation without touching plugin internals.
// ---------------------------------------------------------------------------

export type ConfiguredPlugin<
  TId extends string,
  TExtension extends object,
  TStore,
  TOptions extends object,
  TSchema extends DBSchema | undefined,
> = (
  options?: TOptions & {
    readonly storage?: (deps: StorageDeps<TSchema>) => TStore;
  },
) => Plugin<TId, TExtension, TStore, TSchema>;

// eslint-disable-next-line @typescript-eslint/ban-types
export function definePlugin<
  TId extends string,
  TExtension extends object,
  TStore,
  TSchema extends DBSchema | undefined = undefined,
  TOptions extends object = {},
>(
  authorFactory: (
    options?: TOptions,
  ) => PluginSpec<TId, TExtension, TStore, TSchema>,
): ConfiguredPlugin<TId, TExtension, TStore, TOptions, TSchema> {
  return (options) => {
    const {
      storage: storageOverride,
      ...rest
    }: {
      storage?: (deps: StorageDeps<TSchema>) => TStore;
      [key: string]: unknown;
    } = options ?? {};

    const hasAuthorOptions = Object.keys(rest).length > 0;
    const spec = authorFactory(
      hasAuthorOptions ? (rest as unknown as TOptions) : undefined,
    );

    return {
      ...spec,
      storage: storageOverride ?? spec.storage,
    };
  };
}

// ---------------------------------------------------------------------------
// AnyPlugin / PluginExtensions — type-level glue for the Executor surface.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPlugin = Plugin<string, any, any, any>;

export type PluginExtensions<TPlugins extends readonly AnyPlugin[]> = {
  readonly [P in TPlugins[number] as P["id"]]: P extends Plugin<
    string,
    infer TExt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >
    ? TExt
    : never;
};

/** Lightweight projection of a secret entry as returned by `ctx.secrets.list`. */
export interface SecretListEntry {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

// Re-exported for consumers that check the elicitation handler type.
export type { ElicitationHandler };
