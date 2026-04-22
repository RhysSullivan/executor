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
  StorageFailure,
  TypedAdapter,
  Where,
  WhereOperator,
} from "@executor/storage-core";

export { typedAdapter } from "@executor/storage-core";

// Storage-layer typed errors (re-exported so plugin code can catchTag
// `UniqueViolationError` without importing storage-core directly).
export { StorageError, UniqueViolationError } from "@executor/storage-core";

// IDs (branded)
export { ScopeId, ToolId, SecretId, PolicyId, ConnectionId } from "./ids";

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
  SecretOwnedByConnectionError,
  ConnectionNotFoundError,
  ConnectionProviderNotRegisteredError,
  ConnectionRefreshNotSupportedError,
  ConnectionReauthRequiredError,
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
  type ConnectionRow,
  type DefinitionsInput,
  type ToolAnnotations,
} from "./core-schema";

// Secrets
export {
  SecretRef,
  SetSecretInput,
  type SecretProvider,
} from "./secrets";

// Connections
export {
  ConnectionRef,
  ConnectionKind,
  ConnectionProviderState,
  CreateConnectionInput,
  UpdateConnectionTokensInput,
  TokenMaterial,
  ConnectionRefreshError,
  type ConnectionProvider,
  type ConnectionRefreshInput,
  type ConnectionRefreshResult,
} from "./connections";

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
  type PluginBlobStore,
  pluginBlobStore,
  makeInMemoryBlobStore,
} from "./blob";

// OAuth 2.1 — a single `ctx.oauth` service owns every OAuth flow across
// every plugin. Strategy-parameterized so MCP (dynamic DCR), GraphQL
// (dynamic or static), OpenAPI (spec-configured), and Google (static)
// all hit the same surface. One canonical `"oauth2"` ConnectionProvider
// handles refresh. The helpers + discovery + service implementation all
// live here in core; plugins import from `@executor/sdk`.
export {
  type OAuthService,
  type OAuthStrategy,
  type OAuthDynamicDcrStrategy,
  type OAuthAuthorizationCodeStrategy,
  type OAuthClientCredentialsStrategy,
  type OAuthProviderState,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthStartInput,
  type OAuthStartResult,
  type OAuthCompleteInput,
  type OAuthCompleteResult,
  OAuthProbeError,
  OAuthStartError,
  OAuthCompleteError,
  OAuthSessionNotFoundError,
  OAUTH2_PROVIDER_KEY,
  OAUTH2_SESSION_TTL_MS,
  OAuthStrategy as OAuthStrategySchema,
  OAuthProviderState as OAuthProviderStateSchema,
  OAuthDynamicDcrStrategy as OAuthDynamicDcrStrategySchema,
  OAuthAuthorizationCodeStrategy as OAuthAuthorizationCodeStrategySchema,
  OAuthClientCredentialsStrategy as OAuthClientCredentialsStrategySchema,
} from "./oauth";

// OAuth helpers — PKCE, authorization URL builder, token endpoint
// exchanges (authorization code + client credentials), refresh, and
// response decoding. Previously lived at `@executor/plugin-oauth2`.
export {
  OAuth2Error,
  OAUTH2_DEFAULT_TIMEOUT_MS,
  OAUTH2_REFRESH_SKEW_MS,
  buildAuthorizationUrl,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  refreshAccessToken,
  shouldRefreshToken,
  type OAuth2TokenResponse,
  type BuildAuthorizationUrlInput,
  type ClientAuthMethod,
  type ExchangeAuthorizationCodeInput,
  type ExchangeClientCredentialsInput,
  type RefreshAccessTokenInput,
} from "./oauth-helpers";

// OAuth service factory — exposed for tests / non-default hosts that
// want to construct the service against a custom adapter. `createExecutor`
// uses this internally to build the `ctx.oauth` service and the
// canonical `"oauth2"` ConnectionProvider; hosts don't usually need
// to touch it directly.
export { makeOAuth2Service, type OAuthServiceDeps } from "./oauth-service";

// OAuth discovery — RFC 9728 resource metadata, RFC 8414 + OIDC
// authorization server metadata, RFC 7591 Dynamic Client Registration,
// plus `beginDynamicAuthorization` which chains them with PKCE.
export {
  OAuthDiscoveryError,
  OAuthAuthorizationServerMetadataSchema,
  OAuthClientInformationSchema,
  OAuthProtectedResourceMetadataSchema,
  beginDynamicAuthorization,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  registerDynamicClient,
  type BeginDynamicAuthorizationInput,
  type DiscoveryRequestOptions,
  type DynamicAuthorizationState,
  type DynamicAuthorizationStartResult,
  type DynamicClientMetadata,
  type OAuthAuthorizationServerMetadata,
  type OAuthClientInformation,
  type OAuthProtectedResourceMetadata,
  type RegisterDynamicClientInput,
} from "./oauth-discovery";

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
