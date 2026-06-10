export { openApiPlugin } from "./sdk/plugin";
export type {
  OpenApiPluginOptions,
  OpenApiPluginExtension,
  OpenApiSpecConfig,
  OpenApiSpecInput,
  OpenApiPreviewInput,
} from "./sdk/plugin";

// Auth-template authoring helpers — apikey methods are the shared placements
// model (one placement per header/query spot, each bound to an input variable).
export { TOKEN_VARIABLE, isApiKeyAuthentication, isOAuthAuthentication } from "./sdk/types";
export type { Authentication, APIKeyAuthentication } from "./sdk/types";
