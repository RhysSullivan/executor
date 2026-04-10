import { Context, Data, Effect } from "effect";

import {
  createExecutor as createEffectExecutor,
  ElicitationResponse as ElicitationResponseClass,
  makeInMemoryToolRegistry,
  makeInMemorySecretStore,
  makeInMemoryPolicyEngine,
  makeInMemorySourceRegistry,
  ScopeId,
  ToolId,
  SecretId,
  PolicyId,
  type ToolRegistry as CoreToolRegistry,
  type SourceRegistry as CoreSourceRegistry,
  type SecretStore as CoreSecretStore,
  type PolicyEngine as CorePolicyEngine,
  type ExecutorConfig as EffectExecutorConfig,
  type ExecutorPlugin,
  type PluginContext as EffectPluginContext,
  type PluginHandle as EffectPluginHandle,
  type ElicitationContext,
  type InvokeOptions as EffectInvokeOptions,
  type ToolInvocationResult,
  type ToolMetadata,
  type ToolAnnotations,
  type ToolSchema,
  type ToolInvoker as EffectToolInvoker,
  type RuntimeToolHandler as EffectRuntimeToolHandler,
  type SourceManager as EffectSourceManager,
  type Policy,
  type SecretRef,
  type SecretProvider as EffectSecretProvider,
  type SetSecretInput,
  type Scope,
  type ToolId as ToolIdType,
  type SecretId as SecretIdType,
  type ScopeId as ScopeIdType,
  type PolicyId as PolicyIdType,
  type ToolNotFoundError,
  type ToolInvocationError,
  type SecretNotFoundError,
  type SecretResolutionError,
  type PolicyDeniedError,
  type ElicitationDeclinedError,
  ToolListFilter,
  PolicyCheckInput,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

/**
 * Tagged error produced by the Promise→Effect adapter layer. User-supplied
 * Promise-based store implementations can reject with anything; we wrap the
 * raw rejection in `cause` so downstream code can inspect or re-throw it.
 */
class PromiseAdapterError extends Data.TaggedError("PromiseAdapterError")<{
  readonly cause: unknown;
}> {}

const fromPromise = <A>(fn: () => Promise<A>): Effect.Effect<A, PromiseAdapterError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new PromiseAdapterError({ cause }),
  });

/**
 * Wrap a promise-returning function as an Effect whose error channel is
 * `never`. Unexpected rejections become unhandled defects. Used by the store
 * adapters where the Effect-layer service interface forbids a typed error
 * channel.
 */
const fromPromiseDying = <A>(fn: () => Promise<A>): Effect.Effect<A, never> =>
  Effect.orDie(fromPromise(fn));

/**
 * Wrap a promise-returning function as an Effect whose error channel contains
 * only the expected tagged errors listed in `tags`. If the promise rejects
 * with anything whose `_tag` isn't in the list, the rejection becomes an
 * unhandled defect — users of the promise-shaped store interfaces are expected
 * to throw the documented tagged error types from core.
 */
const fromPromiseTagged = <E extends { readonly _tag: string }, A>(
  fn: () => Promise<A>,
  tags: readonly E["_tag"][],
): Effect.Effect<A, E> =>
  fromPromise(fn).pipe(
    Effect.catchAll((err) => {
      const cause = err.cause;
      if (
        cause !== null &&
        typeof cause === "object" &&
        "_tag" in cause &&
        typeof (cause as { _tag: unknown })._tag === "string" &&
        (tags as readonly string[]).includes((cause as { _tag: string })._tag)
      ) {
        return Effect.fail(cause as E);
      }
      return Effect.die(cause);
    }),
  );

// ---------------------------------------------------------------------------
// Type derivation — derive Promise-based SDK types from core Effect types
// ---------------------------------------------------------------------------

/** Replace branded IDs with plain strings in parameter types */
type UnbrandParam<T> = T extends ToolIdType
  ? string
  : T extends SecretIdType
    ? string
    : T extends ScopeIdType
      ? string
      : T extends PolicyIdType
        ? string
        : T extends readonly (infer U)[]
          ? readonly UnbrandParam<U>[]
          : T;

/** Convert an Effect service interface to Promise-based, unbranding ID params */
type PromisifyService<T> = {
  readonly [K in keyof T]: NonNullable<T[K]> extends (
    ...args: infer A
  ) => Effect.Effect<infer R, infer _E>
    ? (...args: { [I in keyof A]: UnbrandParam<A[I]> }) => Promise<R>
    : T[K];
};

type CoreToolRegistryService = Context.Tag.Service<typeof CoreToolRegistry>;
type CoreSourceRegistryService = Context.Tag.Service<typeof CoreSourceRegistry>;
type CoreSecretStoreService = Context.Tag.Service<typeof CoreSecretStore>;
type CorePolicyEngineService = Context.Tag.Service<typeof CorePolicyEngine>;

// ---------------------------------------------------------------------------
// Elicitation
// ---------------------------------------------------------------------------

export interface ElicitationResponse {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
}

export type ElicitationHandler = (ctx: ElicitationContext) => Promise<ElicitationResponse>;

export interface InvokeOptions {
  readonly onElicitation: ElicitationHandler | "accept-all";
}

const toEffectElicitationHandler = (handler: ElicitationHandler) => (ctx: ElicitationContext) =>
  fromPromise(() => handler(ctx)).pipe(
    Effect.map(
      (r) =>
        new ElicitationResponseClass({
          action: r.action,
          content: r.content,
        }),
    ),
    Effect.catchAll((e) => Effect.die(e.cause)),
  );

const toEffectInvokeOptions = (options: InvokeOptions): EffectInvokeOptions => ({
  onElicitation:
    options.onElicitation === "accept-all"
      ? ("accept-all" as const)
      : toEffectElicitationHandler(options.onElicitation),
});

// ---------------------------------------------------------------------------
// Plugin callback types
// ---------------------------------------------------------------------------

export interface ToolInvoker {
  readonly invoke: (
    toolId: string,
    args: unknown,
    options: InvokeOptions,
  ) => Promise<ToolInvocationResult>;
  readonly resolveAnnotations?: (toolId: string) => Promise<ToolAnnotations | undefined>;
}

export interface RuntimeToolHandler {
  readonly invoke: (args: unknown, options: InvokeOptions) => Promise<ToolInvocationResult>;
  readonly resolveAnnotations?: () => Promise<ToolAnnotations | undefined>;
}

export type SourceManager = PromisifyService<EffectSourceManager>;

export type SecretProvider = PromisifyService<EffectSecretProvider>;

// --- Adapters ---

const effectToPromiseInvokeOptions = (options?: EffectInvokeOptions): InvokeOptions => {
  if (!options || options.onElicitation === "accept-all") return { onElicitation: "accept-all" };
  const handler = options.onElicitation;
  return {
    onElicitation: async (ctx) => {
      const r = await run(handler(ctx));
      return { action: r.action, content: r.content ?? undefined };
    },
  };
};

const toEffectInvoker = (invoker: ToolInvoker): EffectToolInvoker => ({
  invoke: (toolId, args, options) =>
    fromPromiseTagged<ToolInvocationError | ElicitationDeclinedError, ToolInvocationResult>(
      () => invoker.invoke(toolId, args, effectToPromiseInvokeOptions(options)),
      ["ToolInvocationError", "ElicitationDeclinedError"],
    ),
  resolveAnnotations: invoker.resolveAnnotations
    ? (toolId) => fromPromiseDying(() => invoker.resolveAnnotations!(toolId))
    : undefined,
});

const toEffectRuntimeHandler = (handler: RuntimeToolHandler): EffectRuntimeToolHandler => ({
  invoke: (args, options) =>
    fromPromiseTagged<ToolInvocationError | ElicitationDeclinedError, ToolInvocationResult>(
      () => handler.invoke(args, effectToPromiseInvokeOptions(options)),
      ["ToolInvocationError", "ElicitationDeclinedError"],
    ),
  resolveAnnotations: handler.resolveAnnotations
    ? () => fromPromiseDying(() => handler.resolveAnnotations!())
    : undefined,
});

const toEffectSourceManager = (manager: SourceManager): EffectSourceManager => ({
  kind: manager.kind,
  list: () => fromPromiseDying(() => manager.list()),
  remove: (sourceId) => fromPromiseDying(() => manager.remove(sourceId)),
  refresh: manager.refresh
    ? (sourceId) => fromPromiseDying(() => manager.refresh!(sourceId))
    : undefined,
  detect: manager.detect ? (url) => fromPromiseDying(() => manager.detect!(url)) : undefined,
});

const toEffectSecretProvider = (provider: SecretProvider): EffectSecretProvider => ({
  key: provider.key,
  writable: provider.writable,
  get: (key) => fromPromiseDying(() => provider.get(key)),
  set: provider.set ? (key, value) => fromPromiseDying(() => provider.set!(key, value)) : undefined,
  delete: provider.delete ? (key) => fromPromiseDying(() => provider.delete!(key)) : undefined,
  list: provider.list ? () => fromPromiseDying(() => provider.list!()) : undefined,
});

// --- Reverse adapters (Effect -> Promise) for callbacks handed to user stores ---
//
// When the Effect core hands us an Effect-shaped ToolInvoker / ToolHandler /
// SourceManager / SecretProvider (e.g. from a plugin), we need to convert it
// into the promise-shaped equivalent before passing it to a user-supplied
// promise-based store implementation.

const toPromiseInvoker = (invoker: EffectToolInvoker): ToolInvoker => ({
  invoke: (toolId, args, options) =>
    run(
      invoker.invoke(ToolId.make(toolId), args, toEffectInvokeOptions(options)),
    ) as Promise<ToolInvocationResult>,
  resolveAnnotations: invoker.resolveAnnotations
    ? (toolId) => run(invoker.resolveAnnotations!(ToolId.make(toolId)))
    : undefined,
});

const toPromiseRuntimeHandler = (handler: EffectRuntimeToolHandler): RuntimeToolHandler => ({
  invoke: (args, options) =>
    run(handler.invoke(args, toEffectInvokeOptions(options))) as Promise<ToolInvocationResult>,
  resolveAnnotations: handler.resolveAnnotations
    ? () => run(handler.resolveAnnotations!())
    : undefined,
});

const toPromiseSourceManager = (manager: EffectSourceManager): SourceManager => ({
  kind: manager.kind,
  list: () => run(manager.list()),
  remove: (sourceId) => run(manager.remove(sourceId)),
  refresh: manager.refresh ? (sourceId) => run(manager.refresh!(sourceId)) : undefined,
  detect: manager.detect ? (url) => run(manager.detect!(url)) : undefined,
});

const toPromiseSecretProvider = (provider: EffectSecretProvider): SecretProvider => ({
  key: provider.key,
  writable: provider.writable,
  get: (key) => run(provider.get(key)),
  set: provider.set ? (key, value) => run(provider.set!(key, value)) : undefined,
  delete: provider.delete ? (key) => run(provider.delete!(key)) : undefined,
  list: provider.list ? () => run(provider.list!()) : undefined,
});

// --- Main store adapters (Promise -> Effect) ---
//
// Users implementing a pluggable store (e.g. a Postgres-backed tool registry)
// write against the promise-shaped ToolRegistry / SourceRegistry / SecretStore
// / PolicyEngine interfaces declared below. These adapters wrap the user impl
// so the Effect core layer sees a native Effect service.

const toEffectToolRegistry = (r: ToolRegistry): CoreToolRegistryService => ({
  list: (filter) => fromPromiseDying(() => r.list(filter)),
  schema: (toolId) =>
    fromPromiseTagged<ToolNotFoundError, ToolSchema>(() => r.schema(toolId), ["ToolNotFoundError"]),
  definitions: () => fromPromiseDying(() => r.definitions()),
  registerDefinitions: (defs) => fromPromiseDying(() => r.registerDefinitions(defs)),
  registerRuntimeDefinitions: (defs) => fromPromiseDying(() => r.registerRuntimeDefinitions(defs)),
  unregisterRuntimeDefinitions: (names) =>
    fromPromiseDying(() => r.unregisterRuntimeDefinitions(names)),
  registerInvoker: (pluginKey, effectInvoker) =>
    fromPromiseDying(() => r.registerInvoker(pluginKey, toPromiseInvoker(effectInvoker))),
  resolveAnnotations: (toolId) => fromPromiseDying(() => r.resolveAnnotations(toolId)),
  invoke: (toolId, args, options) =>
    fromPromiseTagged<
      ToolNotFoundError | ToolInvocationError | ElicitationDeclinedError,
      ToolInvocationResult
    >(
      () => r.invoke(toolId, args, effectToPromiseInvokeOptions(options)),
      ["ToolNotFoundError", "ToolInvocationError", "ElicitationDeclinedError"],
    ),
  register: (tools) => fromPromiseDying(() => r.register(tools)),
  registerRuntime: (tools) => fromPromiseDying(() => r.registerRuntime(tools)),
  registerRuntimeHandler: (toolId, effectHandler) =>
    fromPromiseDying(() =>
      r.registerRuntimeHandler(toolId, toPromiseRuntimeHandler(effectHandler)),
    ),
  unregisterRuntime: (toolIds) => fromPromiseDying(() => r.unregisterRuntime(toolIds)),
  unregister: (toolIds) => fromPromiseDying(() => r.unregister(toolIds)),
  unregisterBySource: (sourceId) => fromPromiseDying(() => r.unregisterBySource(sourceId)),
});

const toEffectSourceRegistry = (r: SourceRegistry): CoreSourceRegistryService => ({
  addManager: (manager) => fromPromiseDying(() => r.addManager(toPromiseSourceManager(manager))),
  registerRuntime: (source) => fromPromiseDying(() => r.registerRuntime(source)),
  unregisterRuntime: (sourceId) => fromPromiseDying(() => r.unregisterRuntime(sourceId)),
  list: () => fromPromiseDying(() => r.list()),
  remove: (sourceId) => fromPromiseDying(() => r.remove(sourceId)),
  refresh: (sourceId) => fromPromiseDying(() => r.refresh(sourceId)),
  detect: (url) => fromPromiseDying(() => r.detect(url)),
});

const toEffectSecretStore = (s: SecretStore): CoreSecretStoreService => ({
  list: (scopeId) => fromPromiseDying(() => s.list(scopeId)),
  get: (secretId) =>
    fromPromiseTagged<SecretNotFoundError, SecretRef>(
      () => s.get(secretId),
      ["SecretNotFoundError"],
    ),
  resolve: (secretId, scopeId) =>
    fromPromiseTagged<SecretNotFoundError | SecretResolutionError, string>(
      () => s.resolve(secretId, scopeId),
      ["SecretNotFoundError", "SecretResolutionError"],
    ),
  status: (secretId, scopeId) => fromPromiseDying(() => s.status(secretId, scopeId)),
  set: (input) =>
    fromPromiseTagged<SecretResolutionError, SecretRef>(
      () => s.set(input),
      ["SecretResolutionError"],
    ),
  remove: (secretId) =>
    fromPromiseTagged<SecretNotFoundError, boolean>(
      () => s.remove(secretId),
      ["SecretNotFoundError"],
    ),
  addProvider: (provider) =>
    fromPromiseDying(() => s.addProvider(toPromiseSecretProvider(provider))),
  providers: () => fromPromiseDying(() => s.providers()),
});

const toEffectPolicyEngine = (p: PolicyEngine): CorePolicyEngineService => ({
  list: (scopeId) => fromPromiseDying(() => p.list(scopeId)),
  check: (input) =>
    fromPromiseTagged<PolicyDeniedError, void>(
      () => p.check({ scopeId: input.scopeId, toolId: input.toolId }),
      ["PolicyDeniedError"],
    ),
  add: (policy) => fromPromiseDying(() => p.add(policy)),
  remove: (policyId) => fromPromiseDying(() => p.remove(policyId)),
});

// ---------------------------------------------------------------------------
// Plugin context
// ---------------------------------------------------------------------------

export interface PluginContext {
  readonly scope: Scope;
  readonly tools: ToolRegistry;
  readonly sources: SourceRegistry;
  readonly secrets: SecretStore;
  readonly policies: PolicyEngine;
}

export interface ToolRegistry extends Omit<
  PromisifyService<CoreToolRegistryService>,
  "list" | "invoke" | "registerInvoker" | "registerRuntimeHandler"
> {
  readonly list: (filter?: {
    sourceId?: string;
    query?: string;
  }) => Promise<readonly ToolMetadata[]>;
  readonly invoke: (
    toolId: string,
    args: unknown,
    options: InvokeOptions,
  ) => Promise<ToolInvocationResult>;
  readonly registerInvoker: (pluginKey: string, invoker: ToolInvoker) => Promise<void>;
  readonly registerRuntimeHandler: (toolId: string, handler: RuntimeToolHandler) => Promise<void>;
}

export interface SourceRegistry extends Omit<
  PromisifyService<CoreSourceRegistryService>,
  "addManager"
> {
  readonly addManager: (manager: SourceManager) => Promise<void>;
}

export interface SecretStore extends Omit<
  PromisifyService<CoreSecretStoreService>,
  "set" | "addProvider"
> {
  readonly set: (input: {
    readonly id: string;
    readonly scopeId: string;
    readonly name: string;
    readonly value: string;
    readonly provider?: string;
    readonly purpose?: string;
  }) => Promise<SecretRef>;
  readonly addProvider: (provider: SecretProvider) => Promise<void>;
}

export interface PolicyEngine extends Omit<PromisifyService<CorePolicyEngineService>, "check"> {
  readonly check: (input: { scopeId: string; toolId: string }) => Promise<void>;
}

const wrapPluginContext = (ctx: EffectPluginContext): PluginContext => ({
  scope: ctx.scope,
  tools: {
    list: (filter?) => run(ctx.tools.list(filter ? new ToolListFilter(filter) : undefined)),
    schema: (toolId) => run(ctx.tools.schema(ToolId.make(toolId))),
    invoke: (toolId, args, options) =>
      run(ctx.tools.invoke(ToolId.make(toolId), args, toEffectInvokeOptions(options))),
    definitions: () => run(ctx.tools.definitions()),
    registerDefinitions: (defs) => run(ctx.tools.registerDefinitions(defs)),
    registerRuntimeDefinitions: (defs) => run(ctx.tools.registerRuntimeDefinitions(defs)),
    unregisterRuntimeDefinitions: (names) => run(ctx.tools.unregisterRuntimeDefinitions(names)),
    registerInvoker: (pluginKey, invoker) =>
      run(ctx.tools.registerInvoker(pluginKey, toEffectInvoker(invoker))),
    resolveAnnotations: (toolId) => run(ctx.tools.resolveAnnotations(ToolId.make(toolId))),
    register: (tools) => run(ctx.tools.register(tools)),
    registerRuntime: (tools) => run(ctx.tools.registerRuntime(tools)),
    registerRuntimeHandler: (toolId, handler) =>
      run(ctx.tools.registerRuntimeHandler(ToolId.make(toolId), toEffectRuntimeHandler(handler))),
    unregisterRuntime: (toolIds) =>
      run(ctx.tools.unregisterRuntime(toolIds.map((id) => ToolId.make(id)))),
    unregister: (toolIds) => run(ctx.tools.unregister(toolIds.map((id) => ToolId.make(id)))),
    unregisterBySource: (sourceId) => run(ctx.tools.unregisterBySource(sourceId)),
  },
  sources: {
    addManager: (manager) => run(ctx.sources.addManager(toEffectSourceManager(manager))),
    registerRuntime: (source) => run(ctx.sources.registerRuntime(source)),
    unregisterRuntime: (sourceId) => run(ctx.sources.unregisterRuntime(sourceId)),
    list: () => run(ctx.sources.list()),
    remove: (sourceId) => run(ctx.sources.remove(sourceId)),
    refresh: (sourceId) => run(ctx.sources.refresh(sourceId)),
    detect: (url) => run(ctx.sources.detect(url)),
  },
  secrets: {
    list: (scopeId) => run(ctx.secrets.list(ScopeId.make(scopeId))),
    get: (secretId) => run(ctx.secrets.get(SecretId.make(secretId))),
    resolve: (secretId, scopeId) =>
      run(ctx.secrets.resolve(SecretId.make(secretId), ScopeId.make(scopeId))),
    status: (secretId, scopeId) =>
      run(ctx.secrets.status(SecretId.make(secretId), ScopeId.make(scopeId))),
    set: (input) => run(ctx.secrets.set(input as SetSecretInput)),
    remove: (secretId) => run(ctx.secrets.remove(SecretId.make(secretId))),
    addProvider: (provider) => run(ctx.secrets.addProvider(toEffectSecretProvider(provider))),
    providers: () => run(ctx.secrets.providers()),
  },
  policies: {
    list: (scopeId) => run(ctx.policies.list(ScopeId.make(scopeId))),
    check: (input) =>
      run(
        ctx.policies.check(
          new PolicyCheckInput({
            scopeId: ScopeId.make(input.scopeId),
            toolId: ToolId.make(input.toolId),
          }),
        ),
      ),
    add: (policy) => run(ctx.policies.add(policy)),
    remove: (policyId) => run(ctx.policies.remove(PolicyId.make(policyId))),
  },
});

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export interface Plugin<TKey extends string = string, TExtension extends object = object> {
  readonly key: TKey;
  /** @internal */
  readonly _promise?: true;
  readonly init: (ctx: PluginContext) => Promise<PluginHandle<TExtension>>;
}

export interface PluginHandle<TExtension extends object = object> {
  readonly extension: TExtension;
  readonly close?: () => Promise<void>;
}

export const definePlugin = <const TKey extends string, TExtension extends object>(
  plugin: Plugin<TKey, TExtension>,
): Plugin<TKey, TExtension> => ({ ...plugin, _promise: true as const });

const isPromisePlugin = (plugin: { _promise?: boolean }): boolean => plugin._promise === true;

const toEffectPlugin = <TKey extends string, TExtension extends object>(
  plugin: Plugin<TKey, TExtension>,
): ExecutorPlugin<TKey, TExtension> => ({
  key: plugin.key,
  init: (ctx) =>
    fromPromise(async () => {
      const handle = await plugin.init(wrapPluginContext(ctx));
      return {
        extension: handle.extension,
        close: handle.close
          ? () => fromPromise(() => handle.close!()) as Effect.Effect<void>
          : undefined,
      };
    }) as Effect.Effect<EffectPluginHandle<TExtension>, PromiseAdapterError>,
});

// ---------------------------------------------------------------------------
// Executor type
// ---------------------------------------------------------------------------

type Promisified<T> = T extends (...args: infer A) => Effect.Effect<infer R, infer _E>
  ? (...args: A) => Promise<R>
  : T extends object
    ? { readonly [K in keyof T]: Promisified<T[K]> }
    : T;

export type AnyPlugin = Plugin<string, object> | ExecutorPlugin<string, object>;

export type Executor<TPlugins extends readonly AnyPlugin[] = []> = {
  readonly scope: Scope;
  readonly tools: Pick<ToolRegistry, "list" | "schema" | "definitions" | "invoke">;
  readonly sources: Pick<SourceRegistry, "list" | "remove" | "refresh" | "detect">;
  readonly policies: {
    readonly list: () => Promise<readonly Policy[]>;
    readonly add: (policy: Omit<Policy, "id" | "createdAt">) => Promise<Policy>;
    readonly remove: (policyId: string) => Promise<boolean>;
  };
  readonly secrets: {
    readonly list: () => Promise<readonly SecretRef[]>;
    readonly resolve: (secretId: string) => Promise<string>;
    readonly status: (secretId: string) => Promise<"resolved" | "missing">;
    readonly set: (input: {
      readonly id: string;
      readonly name: string;
      readonly value: string;
      readonly provider?: string;
      readonly purpose?: string;
    }) => Promise<SecretRef>;
    readonly remove: (secretId: string) => Promise<boolean>;
    readonly addProvider: (provider: SecretProvider) => Promise<void>;
    readonly providers: () => Promise<readonly string[]>;
  };
  readonly close: () => Promise<void>;
} & PluginExtensions<TPlugins>;

type PluginExtensions<TPlugins extends readonly AnyPlugin[]> = {
  readonly [P in TPlugins[number] as P["key"]]: P extends Plugin<string, infer TExt>
    ? TExt
    : P extends ExecutorPlugin<string, infer TExt>
      ? Promisified<TExt>
      : never;
};

function promisifyObject<T extends object>(obj: T): Promisified<T> {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          if (Effect.isEffect(result)) return run(result as Effect.Effect<unknown, unknown>);
          return result;
        };
      }
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        return promisifyObject(value as object);
      return value;
    },
  }) as Promisified<T>;
}

// ---------------------------------------------------------------------------
// Config & createExecutor
// ---------------------------------------------------------------------------

export interface ExecutorConfig<TPlugins extends readonly AnyPlugin[] = []> {
  readonly scope?: { readonly id?: string; readonly name?: string };
  readonly plugins?: TPlugins;
  /**
   * Custom tool registry implementation. Defaults to an in-memory store.
   * Implement the promise-shaped `ToolRegistry` interface to persist tool
   * metadata to a database, remote service, etc.
   */
  readonly tools?: ToolRegistry;
  /** Custom source registry implementation. Defaults to an in-memory store. */
  readonly sources?: SourceRegistry;
  /**
   * Custom secret store implementation. Defaults to an in-memory store.
   * For most use cases, prefer passing a custom `SecretProvider` via
   * `executor.secrets.addProvider(...)` — only replace the whole store if you
   * need to persist the `SecretRef` metadata itself.
   */
  readonly secrets?: SecretStore;
  /** Custom policy engine implementation. Defaults to an in-memory store. */
  readonly policies?: PolicyEngine;
}

const KNOWN_KEYS = new Set(["scope", "tools", "sources", "policies", "secrets", "close"]);

export const createExecutor = async <const TPlugins extends readonly AnyPlugin[] = []>(
  config: ExecutorConfig<TPlugins> = {},
): Promise<Executor<TPlugins>> => {
  const effectPlugins = (config.plugins ?? []).map((p) =>
    isPromisePlugin(p as { _promise?: boolean })
      ? toEffectPlugin(p as Plugin<string, object>)
      : (p as unknown as ExecutorPlugin<string, object>),
  );

  const effectConfig: EffectExecutorConfig<ExecutorPlugin<string, object>[]> = {
    scope: {
      id: ScopeId.make(config.scope?.id ?? "default"),
      name: config.scope?.name ?? "default",
      createdAt: new Date(),
    },
    tools: config.tools ? toEffectToolRegistry(config.tools) : makeInMemoryToolRegistry(),
    sources: config.sources ? toEffectSourceRegistry(config.sources) : makeInMemorySourceRegistry(),
    secrets: config.secrets ? toEffectSecretStore(config.secrets) : makeInMemorySecretStore(),
    policies: config.policies ? toEffectPolicyEngine(config.policies) : makeInMemoryPolicyEngine(),
    plugins: effectPlugins,
  };

  const executor = await run(createEffectExecutor(effectConfig));

  const base: Record<string, unknown> = {
    scope: executor.scope,
    tools: {
      list: (filter?: { sourceId?: string; query?: string }) =>
        run(executor.tools.list(filter ? new ToolListFilter(filter) : undefined)),
      schema: (toolId: string) => run(executor.tools.schema(toolId)),
      definitions: () => run(executor.tools.definitions()),
      invoke: (toolId: string, args: unknown, options: InvokeOptions) =>
        run(executor.tools.invoke(toolId, args, toEffectInvokeOptions(options))),
    },
    sources: {
      list: () => run(executor.sources.list()),
      remove: (sourceId: string) => run(executor.sources.remove(sourceId)),
      refresh: (sourceId: string) => run(executor.sources.refresh(sourceId)),
      detect: (url: string) => run(executor.sources.detect(url)),
    },
    policies: {
      list: () => run(executor.policies.list()),
      add: (policy: Omit<Policy, "id" | "createdAt">) => run(executor.policies.add(policy)),
      remove: (policyId: string) => run(executor.policies.remove(policyId)),
    },
    secrets: {
      list: () => run(executor.secrets.list()),
      resolve: (secretId: string) => run(executor.secrets.resolve(SecretId.make(secretId))),
      status: (secretId: string) => run(executor.secrets.status(SecretId.make(secretId))),
      set: (input: {
        readonly id: string;
        readonly name: string;
        readonly value: string;
        readonly provider?: string;
        readonly purpose?: string;
      }) => run(executor.secrets.set({ ...input, id: SecretId.make(input.id) })),
      remove: (secretId: string) => run(executor.secrets.remove(SecretId.make(secretId))),
      addProvider: (provider: SecretProvider) =>
        run(executor.secrets.addProvider(toEffectSecretProvider(provider))),
      providers: () => run(executor.secrets.providers()),
    },
    close: () => run(executor.close()),
  };

  for (const key of Object.keys(executor)) {
    if (!KNOWN_KEYS.has(key)) {
      const ext = (executor as Record<string, unknown>)[key];
      if (ext !== null && typeof ext === "object") base[key] = promisifyObject(ext as object);
      else base[key] = ext;
    }
  }

  return base as Executor<TPlugins>;
};
