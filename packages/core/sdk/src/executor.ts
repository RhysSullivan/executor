import { Context, Effect } from "effect";

import type { ToolId, SecretId, PolicyId } from "./ids";
import type { SecretProvider, SecretRef, SecretStore, SetSecretInput } from "./secrets";
import type {
  ToolMetadata,
  ToolSchema,
  ToolInvocationResult,
  ToolRegistry,
  ToolListFilter,
  InvokeOptions,
} from "./tools";
import type { Source, SourceDetectionResult, SourceRegistry } from "./sources";
import type {
  Policy,
  PolicyEngine,
  CreatePolicyPayload,
  UpdatePolicyPayload,
  PolicyDecision,
} from "./policies";
import type { Scope } from "./scope";
import type { ExecutorPlugin, PluginExtensions, PluginHandle } from "./plugin";
import { PolicyDeniedError } from "./errors";
import type {
  ToolNotFoundError,
  ToolInvocationError,
  SecretNotFoundError,
  SecretResolutionError,
  PolicyNotFoundError,
} from "./errors";
import {
  FormElicitation,
  ElicitationDeclinedError,
  ElicitationResponse,
  type ElicitationHandler,
} from "./elicitation";

const resolveElicitationHandler = (options: InvokeOptions): ElicitationHandler =>
  options.onElicitation === "accept-all"
    ? () => Effect.succeed(new ElicitationResponse({ action: "accept" }))
    : options.onElicitation;

// ---------------------------------------------------------------------------
// Executor — the main public API, expands with plugins
// ---------------------------------------------------------------------------

export type Executor<TPlugins extends readonly ExecutorPlugin<string, object>[] = []> = {
  readonly scope: Scope;

  readonly tools: {
    readonly list: (filter?: ToolListFilter) => Effect.Effect<readonly ToolMetadata[]>;
    readonly schema: (toolId: string) => Effect.Effect<ToolSchema, ToolNotFoundError>;
    /** Shared schema definitions across all tools */
    readonly definitions: () => Effect.Effect<Record<string, unknown>>;
    readonly invoke: (
      toolId: string,
      args: unknown,
      options: InvokeOptions,
    ) => Effect.Effect<
      ToolInvocationResult,
      ToolNotFoundError | ToolInvocationError | PolicyDeniedError | ElicitationDeclinedError
    >;
  };

  readonly sources: {
    readonly list: () => Effect.Effect<readonly Source[]>;
    readonly remove: (sourceId: string) => Effect.Effect<void>;
    readonly refresh: (sourceId: string) => Effect.Effect<void>;
    readonly detect: (url: string) => Effect.Effect<readonly SourceDetectionResult[]>;
  };

  readonly policies: {
    readonly list: () => Effect.Effect<readonly Policy[]>;
    readonly get: (policyId: string) => Effect.Effect<Policy, PolicyNotFoundError>;
    readonly add: (policy: CreatePolicyPayload) => Effect.Effect<Policy>;
    readonly update: (
      policyId: string,
      patch: UpdatePolicyPayload,
    ) => Effect.Effect<Policy, PolicyNotFoundError>;
    readonly remove: (policyId: string) => Effect.Effect<boolean>;
  };

  readonly secrets: {
    readonly list: () => Effect.Effect<readonly SecretRef[]>;
    /** Resolve a secret value by id */
    readonly resolve: (
      secretId: SecretId,
    ) => Effect.Effect<string, SecretNotFoundError | SecretResolutionError>;
    /** Check if a secret can be resolved */
    readonly status: (secretId: SecretId) => Effect.Effect<"resolved" | "missing">;
    /** Store a secret value (creates ref + writes to provider) */
    readonly set: (
      input: Omit<SetSecretInput, "scopeId">,
    ) => Effect.Effect<SecretRef, SecretResolutionError>;
    readonly remove: (secretId: SecretId) => Effect.Effect<boolean, SecretNotFoundError>;
    /** Register a secret provider */
    readonly addProvider: (provider: SecretProvider) => Effect.Effect<void>;
    /** List registered provider keys */
    readonly providers: () => Effect.Effect<readonly string[]>;
  };

  readonly close: () => Effect.Effect<void>;
} & PluginExtensions<TPlugins>;

// ---------------------------------------------------------------------------
// Resolved services — what we need to build an Executor
// ---------------------------------------------------------------------------

export type ToolRegistryService = Context.Tag.Service<typeof ToolRegistry>;
export type SourceRegistryService = Context.Tag.Service<typeof SourceRegistry>;
export type SecretStoreService = Context.Tag.Service<typeof SecretStore>;
export type PolicyEngineService = Context.Tag.Service<typeof PolicyEngine>;

export interface ExecutorConfig<TPlugins extends readonly ExecutorPlugin<string, object>[] = []> {
  readonly scope: Scope;
  readonly tools: ToolRegistryService;
  readonly sources: SourceRegistryService;
  readonly secrets: SecretStoreService;
  readonly policies: PolicyEngineService;
  readonly plugins?: TPlugins;
}

// ---------------------------------------------------------------------------
// createExecutor — builds an Executor, initializes plugins
// ---------------------------------------------------------------------------

export const createExecutor = <
  const TPlugins extends readonly ExecutorPlugin<string, object>[] = [],
>(
  config: ExecutorConfig<TPlugins>,
): Effect.Effect<Executor<TPlugins>, Error> =>
  Effect.gen(function* () {
    const { scope, tools, sources, secrets, policies, plugins = [] } = config;

    const runApproval = (
      decision: PolicyDecision,
      toolId: ToolId,
      args: unknown,
      options: InvokeOptions,
      message: string,
      source: "policy" | "annotation",
    ) => {
      const handler = resolveElicitationHandler(options);
      return handler({
        toolId,
        args,
        request: new FormElicitation({
          message,
          requestedSchema: {},
        }),
        approval: {
          source,
          ...(decision.matchedPolicyId ? { matchedPolicyId: decision.matchedPolicyId } : {}),
        },
      });
    };

    // Initialize all plugins
    const handles = new Map<string, PluginHandle<object>>();
    const extensions: Record<string, object> = {};

    for (const plugin of plugins) {
      const handle = yield* plugin.init({
        scope,
        tools,
        sources,
        secrets,
        policies,
      });
      handles.set(plugin.key, handle);
      extensions[plugin.key] = handle.extension;
    }

    const base = {
      scope,

      tools: {
        list: (filter?: ToolListFilter) => tools.list(filter),
        schema: (toolId: string) => tools.schema(toolId as ToolId),
        definitions: () => tools.definitions(),
        invoke: (toolId: string, args: unknown, options: InvokeOptions) => {
          const tid = toolId as ToolId;
          return Effect.gen(function* () {
            const decision = yield* policies.check({ scopeId: scope.id, toolId: tid });

            if (decision.kind === "deny") {
              return yield* new PolicyDeniedError({
                policyId: decision.matchedPolicyId as PolicyId,
                toolId: tid,
                reason: decision.reason,
              });
            }

            if (decision.kind === "require_interaction") {
              const response = yield* runApproval(
                decision,
                tid,
                args,
                options,
                decision.reason,
                "policy",
              );
              if (response.action !== "accept") {
                return yield* new ElicitationDeclinedError({
                  toolId: tid,
                  action: response.action,
                });
              }
              return yield* tools.invoke(tid, args, options);
            }

            if (decision.kind === "allow") {
              return yield* tools.invoke(tid, args, options);
            }

            // Dynamically resolve annotations from the plugin
            const annotations = yield* tools.resolveAnnotations(tid);
            if (annotations?.requiresApproval) {
              const response = yield* runApproval(
                {
                  kind: "fallback",
                  matchedPolicyId: null,
                  reason: annotations.approvalDescription ?? `Approve ${toolId}?`,
                } as PolicyDecision,
                tid,
                args,
                options,
                annotations.approvalDescription ?? `Approve ${toolId}?`,
                "annotation",
              );
              if (response.action !== "accept") {
                return yield* new ElicitationDeclinedError({
                  toolId: tid,
                  action: response.action,
                });
              }
            }

            return yield* tools.invoke(tid, args, options);
          });
        },
      },

      sources: {
        list: () => sources.list(),
        remove: (sourceId: string) => sources.remove(sourceId),
        refresh: (sourceId: string) => sources.refresh(sourceId),
        detect: (url: string) => sources.detect(url),
      },

      policies: {
        list: () => policies.list(scope.id),
        get: (policyId: string) => policies.get(policyId as PolicyId),
        add: (policy: CreatePolicyPayload) =>
          policies.add({ ...policy, scopeId: scope.id }),
        update: (policyId: string, patch: UpdatePolicyPayload) =>
          policies.update(policyId as PolicyId, patch),
        remove: (policyId: string) => policies.remove(policyId as PolicyId),
      },

      secrets: {
        list: () => secrets.list(scope.id),
        resolve: (secretId: SecretId) => secrets.resolve(secretId, scope.id),
        status: (secretId: SecretId) => secrets.status(secretId, scope.id),
        set: (input: Omit<SetSecretInput, "scopeId">) =>
          secrets.set({ ...input, scopeId: scope.id }),
        remove: (secretId: SecretId) => secrets.remove(secretId),
        addProvider: (provider: SecretProvider) => secrets.addProvider(provider),
        providers: () => secrets.providers(),
      },

      close: () =>
        Effect.gen(function* () {
          for (const handle of handles.values()) {
            if (handle.close) yield* handle.close();
          }
        }),
    };

    return Object.assign(base, extensions) as Executor<TPlugins>;
  });
