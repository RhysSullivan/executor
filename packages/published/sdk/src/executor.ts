import { Effect } from "effect";

import {
  createExecutor as createEffectExecutor,
  ElicitationResponse as ElicitationResponseClass,
  makeInMemoryToolRegistry,
  makeInMemorySecretStore,
  makeInMemoryPolicyEngine,
  makeInMemorySourceRegistry,
  ScopeId,
  type ExecutorConfig as EffectExecutorConfig,
  type ExecutorPlugin,
  type PluginContext as EffectPluginContext,
  type ElicitationContext,
  type InvokeOptions as EffectInvokeOptions,
  type ToolInvocationResult,
  type ToolMetadata,
  type ToolSchema,
  type ToolRegistration,
  type ToolAnnotations,
  type ToolInvoker as EffectToolInvoker,
  type RuntimeToolHandler as EffectRuntimeToolHandler,
  type Source,
  type SourceDetectionResult,
  type SourceManager as EffectSourceManager,
  type Policy,
  type SecretRef,
  type SecretProvider as EffectSecretProvider,
  type SetSecretInput,
  type Scope,
  type ToolId,
  type SecretId,
  type ScopeId as ScopeIdType,
  type PolicyId,
} from "@executor/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

const fromPromise = <A>(fn: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: fn, catch: (e) => (e instanceof Error ? e : new Error(String(e))) });

// ---------------------------------------------------------------------------
// Elicitation
// ---------------------------------------------------------------------------

export interface ElicitationResponse {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
}

export type ElicitationHandler = (
  ctx: ElicitationContext,
) => Promise<ElicitationResponse>;

export interface InvokeOptions {
  readonly onElicitation: ElicitationHandler | "accept-all";
}

const toEffectElicitationHandler = (handler: ElicitationHandler) =>
  (ctx: ElicitationContext) =>
    Effect.tryPromise({
      try: () => handler(ctx),
      catch: (e) => e as Error,
    }).pipe(
      Effect.map(
        (r) =>
          new ElicitationResponseClass({
            action: r.action,
            content: r.content,
          }),
      ),
      Effect.catchAll((e) => Effect.die(e)),
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
  readonly invoke: (toolId: string, args: unknown, options: InvokeOptions) => Promise<ToolInvocationResult>;
  readonly resolveAnnotations?: (toolId: string) => Promise<ToolAnnotations | undefined>;
}

export interface RuntimeToolHandler {
  readonly invoke: (args: unknown, options: InvokeOptions) => Promise<ToolInvocationResult>;
  readonly resolveAnnotations?: () => Promise<ToolAnnotations | undefined>;
}

export interface SourceManager {
  readonly kind: string;
  readonly list: () => Promise<readonly Source[]>;
  readonly remove: (sourceId: string) => Promise<void>;
  readonly refresh?: (sourceId: string) => Promise<void>;
  readonly detect?: (url: string) => Promise<SourceDetectionResult | null>;
}

export interface SecretProvider {
  readonly key: string;
  readonly writable: boolean;
  readonly get: (key: string) => Promise<string | null>;
  readonly set?: (key: string, value: string) => Promise<void>;
  readonly delete?: (key: string) => Promise<boolean>;
  readonly list?: () => Promise<readonly { id: string; name: string }[]>;
}

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
    fromPromise(() => invoker.invoke(toolId, args, effectToPromiseInvokeOptions(options))) as Effect.Effect<ToolInvocationResult, any>,
  resolveAnnotations: invoker.resolveAnnotations
    ? (toolId) => fromPromise(() => invoker.resolveAnnotations!(toolId)) as Effect.Effect<ToolAnnotations | undefined>
    : undefined,
});

const toEffectRuntimeHandler = (handler: RuntimeToolHandler): EffectRuntimeToolHandler => ({
  invoke: (args, options) =>
    fromPromise(() => handler.invoke(args, effectToPromiseInvokeOptions(options))) as Effect.Effect<ToolInvocationResult, any>,
  resolveAnnotations: handler.resolveAnnotations
    ? () => fromPromise(() => handler.resolveAnnotations!()) as Effect.Effect<ToolAnnotations | undefined>
    : undefined,
});

const toEffectSourceManager = (manager: SourceManager): EffectSourceManager => ({
  kind: manager.kind,
  list: () => fromPromise(() => manager.list()) as Effect.Effect<readonly Source[]>,
  remove: (sourceId) => fromPromise(() => manager.remove(sourceId)) as Effect.Effect<void>,
  refresh: manager.refresh ? (sourceId) => fromPromise(() => manager.refresh!(sourceId)) as Effect.Effect<void> : undefined,
  detect: manager.detect ? (url) => fromPromise(() => manager.detect!(url)) as Effect.Effect<SourceDetectionResult | null> : undefined,
});

const toEffectSecretProvider = (provider: SecretProvider): EffectSecretProvider => ({
  key: provider.key,
  writable: provider.writable,
  get: (key) => fromPromise(() => provider.get(key)) as Effect.Effect<string | null>,
  set: provider.set ? (key, value) => fromPromise(() => provider.set!(key, value)) as Effect.Effect<void> : undefined,
  delete: provider.delete ? (key) => fromPromise(() => provider.delete!(key)) as Effect.Effect<boolean> : undefined,
  list: provider.list ? () => fromPromise(() => provider.list!()) as Effect.Effect<readonly { id: string; name: string }[]> : undefined,
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

export interface ToolRegistry {
  readonly list: (filter?: { sourceId?: string; query?: string }) => Promise<readonly ToolMetadata[]>;
  readonly schema: (toolId: string) => Promise<ToolSchema>;
  readonly invoke: (toolId: string, args: unknown, options: InvokeOptions) => Promise<ToolInvocationResult>;
  readonly definitions: () => Promise<Record<string, unknown>>;
  readonly registerDefinitions: (defs: Record<string, unknown>) => Promise<void>;
  readonly registerRuntimeDefinitions: (defs: Record<string, unknown>) => Promise<void>;
  readonly unregisterRuntimeDefinitions: (names: readonly string[]) => Promise<void>;
  readonly registerInvoker: (pluginKey: string, invoker: ToolInvoker) => Promise<void>;
  readonly resolveAnnotations: (toolId: string) => Promise<ToolAnnotations | undefined>;
  readonly register: (tools: readonly ToolRegistration[]) => Promise<void>;
  readonly registerRuntime: (tools: readonly ToolRegistration[]) => Promise<void>;
  readonly registerRuntimeHandler: (toolId: string, handler: RuntimeToolHandler) => Promise<void>;
  readonly unregisterRuntime: (toolIds: readonly string[]) => Promise<void>;
  readonly unregister: (toolIds: readonly string[]) => Promise<void>;
  readonly unregisterBySource: (sourceId: string) => Promise<void>;
}

export interface SourceRegistry {
  readonly addManager: (manager: SourceManager) => Promise<void>;
  readonly registerRuntime: (source: Source) => Promise<void>;
  readonly unregisterRuntime: (sourceId: string) => Promise<void>;
  readonly list: () => Promise<readonly Source[]>;
  readonly remove: (sourceId: string) => Promise<void>;
  readonly refresh: (sourceId: string) => Promise<void>;
  readonly detect: (url: string) => Promise<readonly SourceDetectionResult[]>;
}

export interface SecretStore {
  readonly list: (scopeId: string) => Promise<readonly SecretRef[]>;
  readonly get: (secretId: string) => Promise<SecretRef>;
  readonly resolve: (secretId: string, scopeId: string) => Promise<string>;
  readonly status: (secretId: string, scopeId: string) => Promise<"resolved" | "missing">;
  readonly set: (input: { readonly id: string; readonly scopeId: string; readonly name: string; readonly value: string; readonly provider?: string; readonly purpose?: string }) => Promise<SecretRef>;
  readonly remove: (secretId: string) => Promise<boolean>;
  readonly addProvider: (provider: SecretProvider) => Promise<void>;
  readonly providers: () => Promise<readonly string[]>;
}

export interface PolicyEngine {
  readonly list: (scopeId: string) => Promise<readonly Policy[]>;
  readonly check: (input: { scopeId: string; toolId: string }) => Promise<void>;
  readonly add: (policy: Omit<Policy, "id" | "createdAt">) => Promise<Policy>;
  readonly remove: (policyId: string) => Promise<boolean>;
}

const wrapPluginContext = (ctx: EffectPluginContext): PluginContext => ({
  scope: ctx.scope,
  tools: {
    list: (filter?) => run(ctx.tools.list(filter as any)),
    schema: (toolId) => run(ctx.tools.schema(toolId as ToolId)),
    invoke: (toolId, args, options) => run(ctx.tools.invoke(toolId as ToolId, args, toEffectInvokeOptions(options))),
    definitions: () => run(ctx.tools.definitions()),
    registerDefinitions: (defs) => run(ctx.tools.registerDefinitions(defs)),
    registerRuntimeDefinitions: (defs) => run(ctx.tools.registerRuntimeDefinitions(defs)),
    unregisterRuntimeDefinitions: (names) => run(ctx.tools.unregisterRuntimeDefinitions(names)),
    registerInvoker: (pluginKey, invoker) => run(ctx.tools.registerInvoker(pluginKey, toEffectInvoker(invoker))),
    resolveAnnotations: (toolId) => run(ctx.tools.resolveAnnotations(toolId as ToolId)),
    register: (tools) => run(ctx.tools.register(tools)),
    registerRuntime: (tools) => run(ctx.tools.registerRuntime(tools)),
    registerRuntimeHandler: (toolId, handler) => run(ctx.tools.registerRuntimeHandler(toolId as ToolId, toEffectRuntimeHandler(handler))),
    unregisterRuntime: (toolIds) => run(ctx.tools.unregisterRuntime(toolIds as readonly ToolId[])),
    unregister: (toolIds) => run(ctx.tools.unregister(toolIds as readonly ToolId[])),
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
    list: (scopeId) => run(ctx.secrets.list(scopeId as ScopeIdType)),
    get: (secretId) => run(ctx.secrets.get(secretId as SecretId)),
    resolve: (secretId, scopeId) => run(ctx.secrets.resolve(secretId as SecretId, scopeId as ScopeIdType)),
    status: (secretId, scopeId) => run(ctx.secrets.status(secretId as SecretId, scopeId as ScopeIdType)),
    set: (input) => run(ctx.secrets.set(input as SetSecretInput)),
    remove: (secretId) => run(ctx.secrets.remove(secretId as SecretId)),
    addProvider: (provider) => run(ctx.secrets.addProvider(toEffectSecretProvider(provider))),
    providers: () => run(ctx.secrets.providers()),
  },
  policies: {
    list: (scopeId) => run(ctx.policies.list(scopeId as ScopeIdType)),
    check: (input) => run(ctx.policies.check(input as any)),
    add: (policy) => run(ctx.policies.add(policy)),
    remove: (policyId) => run(ctx.policies.remove(policyId as PolicyId)),
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
        close: handle.close ? () => fromPromise(() => handle.close!()) as Effect.Effect<void> : undefined,
      };
    }) as Effect.Effect<any, Error>,
});

// ---------------------------------------------------------------------------
// Executor type
// ---------------------------------------------------------------------------

type Promisified<T> = T extends (...args: infer A) => Effect.Effect<infer R, infer _E>
  ? (...args: A) => Promise<R>
  : T extends object ? { readonly [K in keyof T]: Promisified<T[K]> } : T;

export type AnyPlugin = Plugin<string, object> | ExecutorPlugin<string, object>;

export type Executor<TPlugins extends readonly AnyPlugin[] = []> = {
  readonly scope: Scope;
  readonly tools: {
    readonly list: (filter?: { sourceId?: string; query?: string }) => Promise<readonly ToolMetadata[]>;
    readonly schema: (toolId: string) => Promise<ToolSchema>;
    readonly definitions: () => Promise<Record<string, unknown>>;
    readonly invoke: (toolId: string, args: unknown, options: InvokeOptions) => Promise<ToolInvocationResult>;
  };
  readonly sources: {
    readonly list: () => Promise<readonly Source[]>;
    readonly remove: (sourceId: string) => Promise<void>;
    readonly refresh: (sourceId: string) => Promise<void>;
    readonly detect: (url: string) => Promise<readonly SourceDetectionResult[]>;
  };
  readonly policies: {
    readonly list: () => Promise<readonly Policy[]>;
    readonly add: (policy: Omit<Policy, "id" | "createdAt">) => Promise<Policy>;
    readonly remove: (policyId: string) => Promise<boolean>;
  };
  readonly secrets: {
    readonly list: () => Promise<readonly SecretRef[]>;
    readonly resolve: (secretId: string) => Promise<string>;
    readonly status: (secretId: string) => Promise<"resolved" | "missing">;
    readonly set: (input: { readonly id: string; readonly name: string; readonly value: string; readonly provider?: string; readonly purpose?: string }) => Promise<SecretRef>;
    readonly remove: (secretId: string) => Promise<boolean>;
    readonly addProvider: (provider: SecretProvider) => Promise<void>;
    readonly providers: () => Promise<readonly string[]>;
  };
  readonly close: () => Promise<void>;
} & PluginExtensions<TPlugins>;

type PluginExtensions<TPlugins extends readonly AnyPlugin[]> = {
  readonly [P in TPlugins[number] as P["key"]]: P extends Plugin<string, infer TExt>
    ? TExt
    : P extends ExecutorPlugin<string, infer TExt> ? Promisified<TExt> : never;
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
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return promisifyObject(value as object);
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
}

const KNOWN_KEYS = new Set(["scope", "tools", "sources", "policies", "secrets", "close"]);

export const createExecutor = async <const TPlugins extends readonly AnyPlugin[] = []>(
  config: ExecutorConfig<TPlugins> = {},
): Promise<Executor<TPlugins>> => {
  const effectPlugins = (config.plugins ?? []).map((p) =>
    isPromisePlugin(p as any)
      ? toEffectPlugin(p as Plugin<string, object>)
      : (p as unknown as ExecutorPlugin<string, object>),
  );

  const effectConfig: EffectExecutorConfig<ExecutorPlugin<string, object>[]> = {
    scope: {
      id: ScopeId.make(config.scope?.id ?? "default"),
      name: config.scope?.name ?? "default",
      createdAt: new Date(),
    },
    tools: makeInMemoryToolRegistry(),
    sources: makeInMemorySourceRegistry(),
    secrets: makeInMemorySecretStore(),
    policies: makeInMemoryPolicyEngine(),
    plugins: effectPlugins,
  };

  const executor = await run(createEffectExecutor(effectConfig));

  const base: Record<string, unknown> = {
    scope: executor.scope,
    tools: {
      list: (filter?: { sourceId?: string; query?: string }) => run(executor.tools.list(filter as any)),
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
      resolve: (secretId: string) => run(executor.secrets.resolve(secretId as SecretId)),
      status: (secretId: string) => run(executor.secrets.status(secretId as SecretId)),
      set: (input: { readonly id: string; readonly name: string; readonly value: string; readonly provider?: string; readonly purpose?: string }) =>
        run(executor.secrets.set(input as any)),
      remove: (secretId: string) => run(executor.secrets.remove(secretId as SecretId)),
      addProvider: (provider: SecretProvider) => run(executor.secrets.addProvider(toEffectSecretProvider(provider))),
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
