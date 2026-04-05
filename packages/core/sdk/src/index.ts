// IDs
export { ScopeId, ToolId, SecretId, PolicyId } from "./ids";

// Errors
export {
  ToolNotFoundError,
  ToolInvocationError,
  SecretNotFoundError,
  SecretResolutionError,
  PolicyDeniedError,
} from "./errors";

// Tools
export {
  ToolMetadata,
  ToolSchema,
  ToolInvocationResult,
  ToolRegistry,
  ToolRegistration,
  ToolAnnotations,
  ToolListFilter,
  type ToolInvoker,
  type RuntimeToolHandler,
  type InvokeOptions,
} from "./tools";

// Sources
export {
  Source,
  SourceDetectionResult,
  SourceRegistry,
  makeInMemorySourceRegistry,
  type SourceManager,
} from "./sources";

// Elicitation
export {
  FormElicitation,
  UrlElicitation,
  ElicitationAction,
  ElicitationResponse,
  ElicitationDeclinedError,
  type ElicitationRequest,
  type ElicitationHandler,
  type ElicitationContext,
} from "./elicitation";

// Secrets
export { SecretRef, SetSecretInput, SecretStore, type SecretProvider } from "./secrets";

// Policies
export { Policy, PolicyAction, PolicyCheckInput, PolicyEngine } from "./policies";

// Scope
export { Scope } from "./scope";

// Plugin
export {
  definePlugin,
  type ExecutorPlugin,
  type PluginContext,
  type PluginHandle,
  type PluginExtensions,
} from "./plugin";

// Executor
export {
  createExecutor,
  type Executor,
  type ExecutorConfig,
} from "./executor";

// Built-in plugins
export {
  inMemoryToolsPlugin,
  tool,
  type MemoryToolDefinition,
  type MemoryToolContext,
  type MemoryToolSdkAccess,
  type InMemoryToolsPluginExtension,
} from "./plugins/in-memory-tools";

// Schema ref utilities
export { hoistDefinitions, collectRefs, reattachDefs, normalizeRefs } from "./schema-refs";
export {
  schemaToTypeScriptPreview,
  schemaToTypeScriptPreviewWithDefs,
  buildToolTypeScriptPreview,
  type TypeScriptRenderOptions,
  type TypeScriptSchemaPreview,
} from "./schema-types";

// Runtime tools
export {
  registerRuntimeTools,
  runtimeTool,
  type RuntimeSourceDefinition,
  type RuntimeToolDefinition,
} from "./runtime-tools";

// In-memory implementations
export { makeInMemoryToolRegistry } from "./in-memory/tool-registry";
export { makeInMemorySecretStore, makeInMemorySecretProvider } from "./in-memory/secret-store";
export { makeInMemoryPolicyEngine } from "./in-memory/policy-engine";

// Testing
export { makeTestConfig } from "./testing";
export { type Kv, type ScopedKv, scopeKv, makeInMemoryScopedKv } from "./plugin-kv";
