import { Schema } from "effect";
import type { AuthTemplateSlug } from "@executor-js/sdk/shared";
import type { OAuthAuthentication } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Auth-template model (ported from the v2 scaffold `openapi/types.ts`).
//
// The apiKey template is HTTP-transport-specific: it declares where the user's
// credential goes on the outbound request (headers / query params) via the
// `variable()` templating below. That placement is why it lives with the
// openapi plugin rather than in core. The oauth template is mechanism-intrinsic
// and comes from core (`OAuthAuthentication`); an integration's `Authentication`
// union composes the two. Client credentials (clientId/secret) live on the core
// `OAuthClient`, not here.
// ---------------------------------------------------------------------------

export type AuthenticationVariable = {
  readonly type: "variable";
  readonly name: string;
};

/** A literal string, or a parts-array mixing literals and variable refs. */
export type AuthenticationTemplateValue = string | readonly (string | AuthenticationVariable)[];

export const variable = (name: string): AuthenticationVariable => ({
  type: "variable",
  name,
});

/** The variable name the resolved credential value renders into. */
export const TOKEN_VARIABLE = "token" as const;

export type APIKeyAuthentication = {
  readonly slug: AuthTemplateSlug;
  readonly type: "apiKey";
  readonly headers?: Record<string, AuthenticationTemplateValue>;
  readonly queryParams?: Record<string, AuthenticationTemplateValue>;
};

export type Authentication = OAuthAuthentication | APIKeyAuthentication;

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

export const OperationId = Schema.String.pipe(Schema.brand("OperationId"));
export type OperationId = typeof OperationId.Type;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const HttpMethod = Schema.Literals([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);
export type HttpMethod = typeof HttpMethod.Type;

export const ParameterLocation = Schema.Literals(["path", "query", "header", "cookie"]);
export type ParameterLocation = typeof ParameterLocation.Type;

// ---------------------------------------------------------------------------
// Extracted operation
// ---------------------------------------------------------------------------

export const OperationParameter = Schema.Struct({
  name: Schema.String,
  location: ParameterLocation,
  required: Schema.Boolean,
  schema: Schema.OptionFromOptional(Schema.Unknown),
  style: Schema.OptionFromOptional(Schema.String),
  explode: Schema.OptionFromOptional(Schema.Boolean),
  allowReserved: Schema.OptionFromOptional(Schema.Boolean),
  description: Schema.OptionFromOptional(Schema.String),
});
export type OperationParameter = typeof OperationParameter.Type;

/**
 * OpenAPI 3.x `Encoding Object` (§4.8.15). Declared per-property inside a
 * multipart/form-data or application/x-www-form-urlencoded request body.
 *
 * - `contentType` — for multipart, overrides the per-part `Content-Type`
 *   header (e.g. `application/json` for a JSON-encoded metadata part).
 * - `style` / `explode` / `allowReserved` — for form-urlencoded, control
 *   array / object serialization the same way parameter-level style does.
 */
export const EncodingObject = Schema.Struct({
  contentType: Schema.OptionFromOptional(Schema.String),
  style: Schema.OptionFromOptional(Schema.String),
  explode: Schema.OptionFromOptional(Schema.Boolean),
  allowReserved: Schema.OptionFromOptional(Schema.Boolean),
});
export type EncodingObject = typeof EncodingObject.Type;

export const MediaBinding = Schema.Struct({
  contentType: Schema.String,
  schema: Schema.OptionFromOptional(Schema.Unknown),
  encoding: Schema.OptionFromOptional(Schema.Record(Schema.String, EncodingObject)),
});
export type MediaBinding = typeof MediaBinding.Type;

export const OperationRequestBody = Schema.Struct({
  required: Schema.Boolean,
  /** Default media type — first declared in spec order (not JSON-first).
   *  Used when the caller does not override via the tool's `contentType` arg. */
  contentType: Schema.String,
  /** Schema of the default media type. Kept for backward compat with stored
   *  bindings from before `contents` was added. */
  schema: Schema.OptionFromOptional(Schema.Unknown),
  /** All declared media types in spec order. Populated by `extract.ts`
   *  going forward; older persisted bindings may have this unset and will
   *  fall back to `{contentType, schema}`. */
  contents: Schema.OptionFromOptional(Schema.Array(MediaBinding)),
});
export type OperationRequestBody = typeof OperationRequestBody.Type;

export const ExtractedOperation = Schema.Struct({
  operationId: OperationId,
  toolPath: Schema.OptionFromOptional(Schema.String),
  method: HttpMethod,
  baseUrl: Schema.optional(Schema.String),
  pathTemplate: Schema.String,
  summary: Schema.OptionFromOptional(Schema.String),
  description: Schema.OptionFromOptional(Schema.String),
  tags: Schema.Array(Schema.String),
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.OptionFromOptional(OperationRequestBody),
  inputSchema: Schema.OptionFromOptional(Schema.Unknown),
  outputSchema: Schema.OptionFromOptional(Schema.Unknown),
  deprecated: Schema.Boolean,
});
export type ExtractedOperation = typeof ExtractedOperation.Type;

export const ServerVariable = Schema.Struct({
  default: Schema.String,
  enum: Schema.OptionFromOptional(Schema.Array(Schema.String)),
  description: Schema.OptionFromOptional(Schema.String),
});
export type ServerVariable = typeof ServerVariable.Type;

export const ServerInfo = Schema.Struct({
  url: Schema.String,
  description: Schema.OptionFromOptional(Schema.String),
  variables: Schema.OptionFromOptional(Schema.Record(Schema.String, ServerVariable)),
});
export type ServerInfo = typeof ServerInfo.Type;

export const ExtractionResult = Schema.Struct({
  title: Schema.OptionFromOptional(Schema.String),
  version: Schema.OptionFromOptional(Schema.String),
  servers: Schema.Array(ServerInfo),
  operations: Schema.Array(ExtractedOperation),
});
export type ExtractionResult = typeof ExtractionResult.Type;

// ---------------------------------------------------------------------------
// Operation binding — minimal invocation data (no schemas/metadata)
// ---------------------------------------------------------------------------

export const OperationBinding = Schema.Struct({
  method: HttpMethod,
  baseUrl: Schema.optional(Schema.String),
  pathTemplate: Schema.String,
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.OptionFromOptional(OperationRequestBody),
});
export type OperationBinding = typeof OperationBinding.Type;

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export const InvocationResult = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  data: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.Unknown),
});
export type InvocationResult = typeof InvocationResult.Type;
