export { openApiPlugin } from "./sdk/plugin";
export type {
  OpenApiPluginOptions,
  OpenApiPluginExtension,
  OpenApiSpecConfig,
  OpenApiSpecInput,
  OpenApiPreviewInput,
} from "./sdk/plugin";

// Auth-template authoring helpers. `variable("token")` marks where a
// connection's resolved credential renders into an `apiKey` template.
export { variable, TOKEN_VARIABLE } from "./sdk/types";
export type {
  Authentication,
  APIKeyAuthentication,
  AuthenticationVariable,
  AuthenticationTemplateValue,
} from "./sdk/types";
