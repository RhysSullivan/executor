// Executor
export {
  createExecutor,
  type Executor,
  type ExecutorConfig,
  type AnyPlugin,
} from "./promise-executor";

// Plugin
export {
  definePlugin,
  type Plugin,
  type PluginContext,
  type PluginHandle,
} from "./promise-executor";

// Plugin context services
export type { ToolRegistry, SourceRegistry, SecretStore, PolicyEngine } from "./promise-executor";

// Plugin callback types
export type {
  ToolInvoker,
  RuntimeToolHandler,
  SourceManager,
  SecretProvider,
} from "./promise-executor";

// Invocation
export type { InvokeOptions, ElicitationHandler, ElicitationResponse } from "./promise-executor";

// Re-export data classes from the Effect core that users need
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
  PolicyDecision,
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
  PolicyNotFoundError,
  ElicitationDeclinedError,
} from "./index";
