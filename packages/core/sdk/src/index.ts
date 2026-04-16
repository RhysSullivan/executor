// ---------------------------------------------------------------------------
// @executor/sdk — public surface
// ---------------------------------------------------------------------------

// Storage adapter interface types (re-exported from @executor/storage-core
// so plugin authors can write adapters against a single public surface
// without depending on storage-core directly).
export type {
  DBAdapter,
  DBSchema,
  DBFieldAttribute,
  DBFieldType,
  TypedAdapter,
  Where,
  WhereOperator,
} from "@executor/storage-core";

export { typedAdapter } from "@executor/storage-core";

// IDs (branded)
export { ScopeId, ToolId, SecretId, PolicyId } from "./ids";

// Scope
export { Scope } from "./scope";

// Errors (tagged)
export {
  ToolNotFoundError,
  ToolInvocationError,
  NoHandlerError,
  SourceNotFoundError,
  SourceRemovalNotAllowedError,
  PluginNotLoadedError,
  SecretNotFoundError,
  SecretResolutionError,
  type ExecutorError,
} from "./errors";

// Public projections
export {
  ToolSchema,
  SourceDetectionResult,
  type Source,
  type Tool,
  type ToolListFilter,
} from "./types";

// Core schema
export {
  coreSchema,
  type CoreSchema,
  type SourceInput,
  type SourceInputTool,
  type SourceRow,
  type ToolRow,
  type DefinitionRow,
  type SecretRow,
  type DefinitionsInput,
  type ToolAnnotations,
} from "./core-schema";

// Secrets
export {
  SecretRef,
  SetSecretInput,
  type SecretProvider,
} from "./secrets";

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

// Blob store
export {
  type BlobStore,
  type ScopedBlobStore,
  scopeBlobStore,
  makeInMemoryBlobStore,
} from "./blob";

// Plugin definition
export {
  type Plugin,
  type PluginSpec,
  type PluginCtx,
  type PluginExtensions,
  type ConfiguredPlugin,
  type AnyPlugin,
  type StorageDeps,
  type StaticSourceDecl,
  type StaticToolDecl,
  type StaticToolHandlerInput,
  type InvokeToolInput,
  type SourceLifecycleInput,
  type SecretListEntry,
  type Elicit,
  definePlugin,
  defineSchema,
} from "./plugin";

// Executor
export {
  type Executor,
  type ExecutorConfig,
  type InvokeOptions,
  createExecutor,
  collectSchemas,
} from "./executor";

// CLI config
export {
  defineExecutorConfig,
  type ExecutorCliConfig,
  type ExecutorDialect,
} from "./config";

// Test helper
export { makeTestConfig } from "./testing";

// JSON schema $ref helpers (used by openapi for $defs handling)
export {
  hoistDefinitions,
  collectRefs,
  reattachDefs,
  normalizeRefs,
} from "./schema-refs";

// TypeScript preview generation from JSON schemas
export {
  schemaToTypeScriptPreview,
  schemaToTypeScriptPreviewWithDefs,
  buildToolTypeScriptPreview,
  type TypeScriptRenderOptions,
  type TypeScriptSchemaPreview,
} from "./schema-types";
