// ---------------------------------------------------------------------------
// @executor-js/sdk/promise — public surface for Promise-based consumers.
// ---------------------------------------------------------------------------

export {
  createExecutor,
  type Executor,
  type ExecutorConfig,
  type Promisified,
} from "./promise-executor";

// Identity / projection types that don't carry Effect in their signatures
// are safe to re-export from the Effect surface. Promise consumers need
// these to type arguments they pass in (e.g. SetSecretInput, filters).
export { ScopeId, ToolId, SecretId, PolicyId } from "./ids";
export { Scope } from "./scope";
export { SecretRef, SetSecretInput } from "./secrets";
export {
  ToolSchema,
  SourceDetectionResult,
  type Source,
  type Tool,
  type ToolListFilter,
} from "./types";
export type { ToolAnnotations } from "./core-schema";
export type { AnyPlugin, PluginExtensions } from "./plugin";
export type { OnElicitation, InvokeOptions } from "./executor";

// Elicitation — Promise invoke returns raw values, but consumers still
// may want to reference request/response shapes.
export {
  FormElicitation,
  UrlElicitation,
  ElicitationAction,
  ElicitationResponse,
  type ElicitationRequest,
} from "./elicitation";

// Error tags — Promise callers handle these via .catch().
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
