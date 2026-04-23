import { Schema } from "effect";
import { ConnectionId, ScopeId, SecretId } from "@executor/sdk";

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

/**
 * OpenAPI 3.x `Encoding Object` (§4.8.15). Declared per-property inside a
 * multipart/form-data or application/x-www-form-urlencoded request body.
 *
 * - `contentType` — for multipart, overrides the per-part `Content-Type`
 *   header (e.g. `application/json` for a JSON-encoded metadata part).
 * - `style` / `explode` / `allowReserved` — for form-urlencoded, control
 *   array / object serialization the same way parameter-level style does.
 */
export class EncodingObject extends Schema.Class<EncodingObject>("EncodingObject")({
  contentType: Schema.optionalWith(Schema.String, { as: "Option" }),
  style: Schema.optionalWith(Schema.String, { as: "Option" }),
  explode: Schema.optionalWith(Schema.Boolean, { as: "Option" }),
  allowReserved: Schema.optionalWith(Schema.Boolean, { as: "Option" }),
}) {}

export class MediaBinding extends Schema.Class<MediaBinding>("MediaBinding")({
  contentType: Schema.String,
  schema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  encoding: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: EncodingObject }),
    { as: "Option" },
  ),
}) {}

export class OperationRequestBody extends Schema.Class<OperationRequestBody>(
  "OperationRequestBody",
)({
  required: Schema.Boolean,
  /** Default media type — first declared in spec order (not JSON-first).
   *  Used when the caller does not override via the tool's `contentType` arg. */
  contentType: Schema.String,
  /** Schema of the default media type. Kept for backward compat with stored
   *  bindings from before `contents` was added. */
  schema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  /** All declared media types in spec order. Populated by `extract.ts`
   *  going forward; older persisted bindings may have this unset and will
   *  fall back to `{contentType, schema}`. */
  contents: Schema.optionalWith(Schema.Array(MediaBinding), { as: "Option" }),
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

export class ConfiguredHeaderBinding extends Schema.Class<ConfiguredHeaderBinding>(
  "OpenApiConfiguredHeaderBinding",
)({
  kind: Schema.Literal("binding"),
  slot: Schema.String,
  prefix: Schema.optional(Schema.String),
}) {}

export const ConfiguredHeaderValue = Schema.Union(
  Schema.String,
  ConfiguredHeaderBinding,
);
export type ConfiguredHeaderValue = typeof ConfiguredHeaderValue.Type;

export const OpenApiSourceBindingValue = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("secret"),
    secretId: SecretId,
  }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    connectionId: ConnectionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.String,
  }),
);
export type OpenApiSourceBindingValue = typeof OpenApiSourceBindingValue.Type;

export class OpenApiSourceBindingInput extends Schema.Class<OpenApiSourceBindingInput>(
  "OpenApiSourceBindingInput",
)({
  sourceId: Schema.String,
  sourceScope: ScopeId,
  scope: ScopeId,
  slot: Schema.String,
  value: OpenApiSourceBindingValue,
}) {}

export class OpenApiSourceBindingRef extends Schema.Class<OpenApiSourceBindingRef>(
  "OpenApiSourceBindingRef",
)({
  sourceId: Schema.String,
  sourceScopeId: ScopeId,
  scopeId: ScopeId,
  slot: Schema.String,
  value: OpenApiSourceBindingValue,
  createdAt: Schema.DateFromNumber,
  updatedAt: Schema.DateFromNumber,
}) {}

// ---------------------------------------------------------------------------
// OAuth2 auth — points at the Connection that owns live tokens, and also
// carries enough API-level config to kick off a fresh sign-in from the
// source detail UI without needing the connection to still exist.
//
// Split of responsibilities:
//   - The Source owns: the OAuth config (tokenUrl, authorizationUrl,
//     client credential secret ids, scopes, flow, securitySchemeName).
//     Values are a property of the target API, identical for every user
//     signing into this source. Source-owned = reconnect works even if
//     the connection row has been removed.
//   - The Connection owns: live access/refresh tokens, token expiry,
//     provider state the refresh path reads from. The connection's
//     `providerState` caches the refresh-relevant bits of the config
//     so the refresh loop never reaches back into source storage.
//
// This is a deliberate small duplication (scopes + tokenUrl +
// clientIdSecretId + clientSecretSecretId appear on both). The values
// are static per source so the two copies can't drift.
// ---------------------------------------------------------------------------

export const OAuth2Flow = Schema.Literal("authorizationCode", "clientCredentials");
export type OAuth2Flow = typeof OAuth2Flow.Type;

export class OAuth2Auth extends Schema.Class<OAuth2Auth>("OpenApiOAuth2Auth")({
  kind: Schema.Literal("oauth2"),
  /** Id of the Connection that owns this sign-in. Points at the core
   *  `connection` table; resolve via `ctx.connections.get(id)` or
   *  `ctx.connections.accessToken(id)`. Updated when the user signs in
   *  again from the source detail UI (a fresh connection is minted and
   *  this pointer is rewritten). */
  connectionId: Schema.String,
  /** Key into `components.securitySchemes` this auth came from. Kept here
   *  so a spec with multiple OAuth2 schemes can wire each one to its own
   *  connection. */
  securitySchemeName: Schema.String,
  /** OAuth2 grant type used for this source. Determines which flow the
   *  sign-in button runs (authorizationCode opens a browser popup;
   *  clientCredentials is server-to-server). */
  flow: OAuth2Flow,
  /** Absolute token endpoint URL. */
  tokenUrl: Schema.String,
  /** Absolute authorization endpoint URL. Only used for authorizationCode
   *  flows; clientCredentials has no user consent step. */
  authorizationUrl: Schema.NullOr(Schema.String),
  /** Secret id holding the OAuth client_id. */
  clientIdSecretId: Schema.String,
  /** Secret id holding the OAuth client_secret. Optional for public
   *  clients (PKCE-only authorizationCode). */
  clientSecretSecretId: Schema.NullOr(Schema.String),
  /** OAuth scopes requested on sign-in. Stored as a static list so the
   *  sign-in button can re-request the same capabilities without having
   *  to re-derive them from the OpenAPI spec. */
  scopes: Schema.Array(Schema.String),
}) {}

export class OAuth2SourceConfig extends Schema.Class<OAuth2SourceConfig>(
  "OpenApiOAuth2SourceConfig",
)({
  kind: Schema.Literal("oauth2"),
  securitySchemeName: Schema.String,
  flow: OAuth2Flow,
  tokenUrl: Schema.String,
  authorizationUrl: Schema.NullOr(Schema.String),
  clientIdSlot: Schema.String,
  clientSecretSlot: Schema.NullOr(Schema.String),
  connectionSlot: Schema.String,
  scopes: Schema.Array(Schema.String),
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
// Pending OAuth session — persisted between startOAuth and completeOAuth.
// All the fields the exchange needs (token endpoint, client credential
// secret ids, redirect URL, PKCE verifier) plus the pre-decided Connection
// / secret ids the SDK stamps when the user returns.
// ---------------------------------------------------------------------------

export class OpenApiOAuthSession extends Schema.Class<OpenApiOAuthSession>(
  "OpenApiOAuthSession",
)({
  /** Display name used for the resulting Connection's identity label. */
  displayName: Schema.String,
  securitySchemeName: Schema.String,
  /** Only authorizationCode reaches this session type. client_credentials
   *  has no user-interactive step so it creates the Connection inline in
   *  `startOAuth` without persisting a session. */
  flow: Schema.Literal("authorizationCode"),
  tokenUrl: Schema.String,
  /** Absolute authorization endpoint — persisted so completeOAuth can
   *  stamp it onto the resulting `OAuth2Auth` for future sign-ins. */
  authorizationUrl: Schema.String,
  redirectUrl: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  /** Executor scope that will own the resulting Connection (and its
   *  backing secret rows). Typically the innermost (per-user) scope. */
  tokenScope: Schema.String,
  /** Pre-decided Connection id stamped at `completeOAuth` time. */
  connectionId: Schema.String,
  /** Pre-decided secret ids for the Connection's access + refresh
   *  tokens. Fixed at session creation so a retried callback lands
   *  on the same ids. */
  accessTokenSecretId: Schema.String,
  refreshTokenSecretId: Schema.String,
  scopes: Schema.Array(Schema.String),
  codeVerifier: Schema.String,
}) {}

export class InvocationResult extends Schema.Class<InvocationResult>("InvocationResult")({
  status: Schema.Number,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  data: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.Unknown),
}) {}
