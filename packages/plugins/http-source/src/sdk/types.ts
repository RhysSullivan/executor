import { Schema } from "effect";

export const HttpCredentialSlotConfig = Schema.Struct({
  slotKey: Schema.String,
  label: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  prefix: Schema.optional(Schema.String),
}).annotate({ identifier: "HttpCredentialSlotConfig" });
export type HttpCredentialSlotConfig = typeof HttpCredentialSlotConfig.Type;

export const HttpOAuthTokenPlacement = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("header"),
    name: Schema.String,
    scheme: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("query"),
    name: Schema.String,
  }),
]).annotate({ identifier: "HttpOAuthTokenPlacement" });
export type HttpOAuthTokenPlacement = typeof HttpOAuthTokenPlacement.Type;

export const HttpOAuthSourceConfig = Schema.Struct({
  authorizationUrl: Schema.NullOr(Schema.String),
  tokenUrl: Schema.String,
  issuerUrl: Schema.optional(Schema.NullOr(Schema.String)),
  clientIdSlot: Schema.String,
  clientSecretSlot: Schema.NullOr(Schema.String),
  connectionSlot: Schema.String,
  scopes: Schema.Array(Schema.String),
  placement: HttpOAuthTokenPlacement,
}).annotate({ identifier: "HttpOAuthSourceConfig" });
export type HttpOAuthSourceConfig = typeof HttpOAuthSourceConfig.Type;

export const HttpRequestSourceConfig = Schema.Struct({
  headers: Schema.optional(Schema.Record(Schema.String, HttpCredentialSlotConfig)),
  query: Schema.optional(Schema.Record(Schema.String, HttpCredentialSlotConfig)),
  oauth: Schema.optional(HttpOAuthSourceConfig),
}).annotate({ identifier: "HttpRequestSourceConfig" });
export type HttpRequestSourceConfig = typeof HttpRequestSourceConfig.Type;

export const HttpCredentialInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("secret"),
    secretId: Schema.String,
    secretScope: Schema.optional(Schema.String),
    prefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("connection"),
    connectionId: Schema.String,
  }),
]);
export type HttpCredentialInput = typeof HttpCredentialInput.Type;

export const HttpConfiguredValueInput = Schema.Union([
  Schema.String,
  Schema.Struct({
    kind: Schema.Literal("secret"),
    prefix: Schema.optional(Schema.String),
  }),
]);
export type HttpConfiguredValueInput = typeof HttpConfiguredValueInput.Type;

export const OAuth2Flow = Schema.Literals(["authorizationCode", "clientCredentials"]);
export type OAuth2Flow = typeof OAuth2Flow.Type;

export const OAuth2SourceConfig = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  securitySchemeName: Schema.String,
  flow: OAuth2Flow,
  tokenUrl: Schema.String,
  authorizationUrl: Schema.NullOr(Schema.String),
  issuerUrl: Schema.optional(Schema.NullOr(Schema.String)),
  clientIdSlot: Schema.String,
  clientSecretSlot: Schema.NullOr(Schema.String),
  connectionSlot: Schema.String,
  scopes: Schema.Array(Schema.String),
}).annotate({ identifier: "HttpOAuth2SourceConfig" });
export type OAuth2SourceConfig = typeof OAuth2SourceConfig.Type;

export const HttpOAuthConfigureInput = Schema.Struct({
  clientId: Schema.optional(HttpCredentialInput),
  clientSecret: Schema.optional(Schema.NullOr(HttpCredentialInput)),
  connection: Schema.optional(HttpCredentialInput),
}).annotate({ identifier: "HttpOAuthConfigureInput" });
export type HttpOAuthConfigureInput = typeof HttpOAuthConfigureInput.Type;

export const HttpRequestConfigureInput = Schema.Struct({
  headers: Schema.optional(Schema.Record(Schema.String, HttpCredentialInput)),
  query: Schema.optional(Schema.Record(Schema.String, HttpCredentialInput)),
  oauth: Schema.optional(HttpOAuthConfigureInput),
}).annotate({ identifier: "HttpRequestConfigureInput" });
export type HttpRequestConfigureInput = typeof HttpRequestConfigureInput.Type;

export const HttpCredentialManifestEntry = Schema.Struct({
  slotKey: Schema.String,
  label: Schema.String,
  family: Schema.Literals(["http.header", "http.query", "http.oauth"]),
  required: Schema.Boolean,
  prefix: Schema.optional(Schema.String),
  placement: Schema.optional(
    Schema.Struct({
      section: Schema.String,
      name: Schema.String,
    }),
  ),
}).annotate({ identifier: "HttpCredentialManifestEntry" });
export type HttpCredentialManifestEntry = typeof HttpCredentialManifestEntry.Type;
