import { Schema } from "effect";

export const GoogleDiscoveryHttpMethod = Schema.Literal(
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
);
export type GoogleDiscoveryHttpMethod = typeof GoogleDiscoveryHttpMethod.Type;

export const GoogleDiscoveryParameterLocation = Schema.Literal("path", "query", "header");
export type GoogleDiscoveryParameterLocation = typeof GoogleDiscoveryParameterLocation.Type;

export class GoogleDiscoveryParameter extends Schema.Class<GoogleDiscoveryParameter>(
  "GoogleDiscoveryParameter",
)({
  name: Schema.String,
  location: GoogleDiscoveryParameterLocation,
  required: Schema.Boolean,
  repeated: Schema.Boolean,
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
  schema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
}) {}

export class GoogleDiscoveryMethodBinding extends Schema.Class<GoogleDiscoveryMethodBinding>(
  "GoogleDiscoveryMethodBinding",
)({
  method: GoogleDiscoveryHttpMethod,
  pathTemplate: Schema.String,
  parameters: Schema.Array(GoogleDiscoveryParameter),
  hasBody: Schema.Boolean,
}) {}

export class GoogleDiscoveryManifestMethod extends Schema.Class<GoogleDiscoveryManifestMethod>(
  "GoogleDiscoveryManifestMethod",
)({
  toolPath: Schema.String,
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
  binding: GoogleDiscoveryMethodBinding,
  inputSchema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  outputSchema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  scopes: Schema.Array(Schema.String),
}) {}

export class GoogleDiscoveryManifest extends Schema.Class<GoogleDiscoveryManifest>(
  "GoogleDiscoveryManifest",
)({
  title: Schema.optionalWith(Schema.String, { as: "Option" }),
  service: Schema.String,
  version: Schema.String,
  rootUrl: Schema.String,
  servicePath: Schema.String,
  oauthScopes: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.String }), {
    as: "Option",
  }),
  schemaDefinitions: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  methods: Schema.Array(GoogleDiscoveryManifestMethod),
}) {}

export const GoogleDiscoveryAuth = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    clientId: Schema.String,
    clientSecretSecretId: Schema.NullOr(Schema.String),
    accessTokenSecretId: Schema.String,
    refreshTokenSecretId: Schema.NullOr(Schema.String),
    tokenType: Schema.optionalWith(Schema.String, { default: () => "Bearer" }),
    expiresAt: Schema.NullOr(Schema.Number),
    scope: Schema.NullOr(Schema.String),
    scopes: Schema.Array(Schema.String),
  }),
);
export type GoogleDiscoveryAuth = typeof GoogleDiscoveryAuth.Type;

export class GoogleDiscoveryStoredSourceData extends Schema.Class<GoogleDiscoveryStoredSourceData>(
  "GoogleDiscoveryStoredSourceData",
)({
  name: Schema.String,
  discoveryUrl: Schema.String,
  service: Schema.String,
  version: Schema.String,
  rootUrl: Schema.String,
  servicePath: Schema.String,
  auth: GoogleDiscoveryAuth,
}) {}

export class GoogleDiscoveryInvocationResult extends Schema.Class<GoogleDiscoveryInvocationResult>(
  "GoogleDiscoveryInvocationResult",
)({
  status: Schema.Number,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  data: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.Unknown),
}) {}

export interface GoogleDiscoverySourceMeta {
  readonly namespace: string;
  readonly name: string;
}

/** Pending OAuth session persisted between startOAuth and completeOAuth */
export const GoogleDiscoveryOAuthSession = Schema.Struct({
  discoveryUrl: Schema.String,
  name: Schema.String,
  clientId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  redirectUrl: Schema.String,
  scopes: Schema.Array(Schema.String),
  codeVerifier: Schema.String,
});
export type GoogleDiscoveryOAuthSession = typeof GoogleDiscoveryOAuthSession.Type;
