// Executor
export {
  createExecutor,
  type Executor,
  type ExecutorConfig,
  type AnyPlugin,
} from "./executor";

// Plugin
export {
  definePlugin,
  type Plugin,
  type PluginContext,
  type PluginHandle,
} from "./executor";

// Plugin context services
export type {
  ToolRegistry,
  SourceRegistry,
  SecretStore,
  PolicyEngine,
} from "./executor";

// Plugin callback types
export type {
  ToolInvoker,
  RuntimeToolHandler,
  SourceManager,
  SecretProvider,
} from "./executor";

// Invocation
export type {
  InvokeOptions,
  ElicitationHandler,
  ElicitationResponse,
} from "./executor";

// Re-export data classes from @executor/core that users need
export {
  ToolRegistration,
  ToolInvocationResult,
  ToolMetadata,
  ToolSchema,
  ToolAnnotations,
  ToolListFilter,
  ToolId,
  SecretId,
  ScopeId,
  PolicyId,
  Source,
  SourceDetectionResult,
  SecretRef,
  Policy,
  Scope,
  FormElicitation,
  UrlElicitation,
  type ElicitationContext,
  type ElicitationRequest,
  // Errors
  ToolNotFoundError,
  ToolInvocationError,
  SecretNotFoundError,
  SecretResolutionError,
  PolicyDeniedError,
  ElicitationDeclinedError,
} from "@executor/core";
