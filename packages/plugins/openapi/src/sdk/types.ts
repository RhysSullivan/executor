import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

export const OperationId = Schema.String.pipe(Schema.brand("OperationId"));
export type OperationId = typeof OperationId.Type;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const HttpMethod = Schema.Literal(
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
);
export type HttpMethod = typeof HttpMethod.Type;

export const ParameterLocation = Schema.Literal("path", "query", "header", "cookie");
export type ParameterLocation = typeof ParameterLocation.Type;

// ---------------------------------------------------------------------------
// Extracted operation
// ---------------------------------------------------------------------------

export class OperationParameter extends Schema.Class<OperationParameter>("OperationParameter")({
  name: Schema.String,
  location: ParameterLocation,
  required: Schema.Boolean,
  schema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  style: Schema.optionalWith(Schema.String, { as: "Option" }),
  explode: Schema.optionalWith(Schema.Boolean, { as: "Option" }),
  allowReserved: Schema.optionalWith(Schema.Boolean, { as: "Option" }),
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
}) {}

export class OperationRequestBody extends Schema.Class<OperationRequestBody>(
  "OperationRequestBody",
)({
  required: Schema.Boolean,
  contentType: Schema.String,
  schema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
}) {}

export class ExtractedOperation extends Schema.Class<ExtractedOperation>("ExtractedOperation")({
  operationId: OperationId,
  method: HttpMethod,
  pathTemplate: Schema.String,
  summary: Schema.optionalWith(Schema.String, { as: "Option" }),
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
  tags: Schema.Array(Schema.String),
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.optionalWith(OperationRequestBody, { as: "Option" }),
  inputSchema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  outputSchema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  deprecated: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}) {}

export class ServerVariable extends Schema.Class<ServerVariable>("ServerVariable")({
  default: Schema.String,
  enum: Schema.optionalWith(Schema.Array(Schema.String), { as: "Option" }),
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
}) {}

export class ServerInfo extends Schema.Class<ServerInfo>("ServerInfo")({
  url: Schema.String,
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
  variables: Schema.optionalWith(Schema.Record({ key: Schema.String, value: ServerVariable }), {
    as: "Option",
  }),
}) {}

export class ExtractionResult extends Schema.Class<ExtractionResult>("ExtractionResult")({
  title: Schema.optionalWith(Schema.String, { as: "Option" }),
  version: Schema.optionalWith(Schema.String, { as: "Option" }),
  servers: Schema.Array(ServerInfo),
  operations: Schema.Array(ExtractedOperation),
}) {}

// ---------------------------------------------------------------------------
// Operation binding — minimal invocation data (no schemas/metadata)
// ---------------------------------------------------------------------------

export class OperationBinding extends Schema.Class<OperationBinding>("OperationBinding")({
  method: HttpMethod,
  pathTemplate: Schema.String,
  parameters: Schema.Array(OperationParameter),
  requestBody: Schema.optionalWith(OperationRequestBody, { as: "Option" }),
}) {}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/**
 * A header value — either a static string or a reference to a secret.
 * Stored as JSON-serializable data.
 */
export const HeaderValue = Schema.Union(
  Schema.String,
  Schema.Struct({
    secretId: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
);
export type HeaderValue = typeof HeaderValue.Type;

// ---------------------------------------------------------------------------
// OAuth2 auth — applied as Authorization: Bearer <token> at invocation time.
// Tokens are stored as secrets; the bearer value is resolved (and refreshed)
// on every request via withRefreshedAccessToken.
// ---------------------------------------------------------------------------

export class OAuth2Auth extends Schema.Class<OAuth2Auth>("OpenApiOAuth2Auth")({
  kind: Schema.Literal("oauth2"),
  /** Key into `components.securitySchemes` this auth came from. */
  securitySchemeName: Schema.String,
  /**
   * Which flow produced this auth. `clientCredentials` sources have no
   * refresh token — the invoker re-exchanges via client_credentials when
   * the access token is near expiry.
   */
  flow: Schema.Literal("authorizationCode", "clientCredentials"),
  /** Token endpoint (from the flow) — used for refresh / re-exchange. */
  tokenUrl: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.NullOr(Schema.String),
  tokenType: Schema.String,
  /** Epoch ms when the access token expires; null if the server did not declare an expiry. */
  expiresAt: Schema.NullOr(Schema.Number),
  /** Scope string as returned by the token endpoint. */
  scope: Schema.NullOr(Schema.String),
  /** Scopes this auth was granted (for display + refresh). */
  scopes: Schema.Array(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Annotation policy — per-source override of the HTTP-method-based default
// for `requiresApproval`. If `requireApprovalFor` is set, it replaces the
// default set ({POST, PUT, PATCH, DELETE}) wholesale: any method present
// requires approval, any method absent does not.
// ---------------------------------------------------------------------------

export class AnnotationPolicy extends Schema.Class<AnnotationPolicy>(
  "OpenApiAnnotationPolicy",
)({
  requireApprovalFor: Schema.optional(Schema.Array(HttpMethod)),
}) {}

export class InvocationConfig extends Schema.Class<InvocationConfig>("InvocationConfig")({
  baseUrl: Schema.String,
  /** Headers applied to every request. Values can reference secrets. */
  headers: Schema.optionalWith(Schema.Record({ key: Schema.String, value: HeaderValue }), {
    default: () => ({}),
  }),
  /**
   * Optional OAuth2 auth — if set, the invoker resolves/refreshes the
   * access token and injects `Authorization: Bearer <token>` on every
   * request. Coexists with `headers` but wins for the Authorization header.
   */
  oauth2: Schema.optionalWith(OAuth2Auth, { as: "Option" }),
}) {}

// ---------------------------------------------------------------------------
// Pending OAuth session — persisted between startOAuth and completeOAuth
// ---------------------------------------------------------------------------

export class OpenApiOAuthSession extends Schema.Class<OpenApiOAuthSession>(
  "OpenApiOAuthSession",
)({
  /** Display name used for the stored token secret labels. */
  displayName: Schema.String,
  securitySchemeName: Schema.String,
  /** For now only authorizationCode is supported end-to-end; clientCredentials is follow-up work. */
  flow: Schema.Literal("authorizationCode"),
  tokenUrl: Schema.String,
  redirectUrl: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  /**
   * Executor scope id where the minted access/refresh token secrets will
   * land when `completeOAuth` runs. Typically the innermost (per-user)
   * scope. Persisted in the session so the callback that completes the
   * flow writes tokens to the same tenancy the caller intended at
   * `startOAuth` time.
   */
  tokenScope: Schema.String,
  /**
   * Pre-decided secret ids for the minted access + refresh tokens. The
   * caller names these so the source's `OAuth2Auth` can reference the
   * same ids regardless of which scope actually owns the value —
   * `ctx.secrets.get` resolves them via fallthrough (innermost first),
   * so per-user tokens shadow org-level fallbacks on the same source.
   */
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
  codeVerifier: Schema.String,
}) {}

export class InvocationResult extends Schema.Class<InvocationResult>("InvocationResult")({
  status: Schema.Number,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  data: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.Unknown),
}) {}
