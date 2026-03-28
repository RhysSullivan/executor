import * as Schema from "effect/Schema";

import {
  SecretRefSchema,
  StringMapSchema,
} from "@executor/platform-sdk/schema";

export const GOOGLE_DISCOVERY_SOURCE_KIND = "google_discovery" as const;
export const GOOGLE_DISCOVERY_PLUGIN_KEY = "google-discovery" as const;
export const GOOGLE_DISCOVERY_EXECUTOR_KEY = "googleDiscovery" as const;
export const GOOGLE_DISCOVERY_OAUTH_STORAGE_PREFIX =
  "executor:google-discovery-oauth:" as const;
export const GOOGLE_DISCOVERY_OAUTH_CALLBACK_PATH =
  `/v1/plugins/${GOOGLE_DISCOVERY_PLUGIN_KEY}/oauth/callback` as const;

export const GoogleDiscoveryOAuthClientAuthenticationSchema = Schema.Literal(
  "none",
  "client_secret_post",
);

export const GoogleDiscoveryConnectionAuthSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("bearer"),
    tokenSecretRef: SecretRefSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    clientId: Schema.String,
    clientSecretRef: Schema.NullOr(SecretRefSchema),
    clientAuthentication: GoogleDiscoveryOAuthClientAuthenticationSchema,
    authorizationEndpoint: Schema.String,
    tokenEndpoint: Schema.String,
    scopes: Schema.Array(Schema.String),
    accessTokenRef: SecretRefSchema,
    refreshTokenRef: Schema.NullOr(SecretRefSchema),
    expiresAt: Schema.NullOr(Schema.Number),
  }),
);

export const GoogleDiscoveryConnectInputSchema = Schema.Struct({
  name: Schema.String,
  service: Schema.String,
  version: Schema.String,
  discoveryUrl: Schema.NullOr(Schema.String),
  defaultHeaders: Schema.NullOr(StringMapSchema),
  scopes: Schema.Array(Schema.String),
  auth: GoogleDiscoveryConnectionAuthSchema,
});

export const GoogleDiscoverySourceConfigPayloadSchema =
  GoogleDiscoveryConnectInputSchema;

export const GoogleDiscoveryUpdateSourceInputSchema = Schema.Struct({
  sourceId: Schema.String,
  config: GoogleDiscoverySourceConfigPayloadSchema,
});

export const GoogleDiscoveryStoredSourceDataSchema = Schema.Struct({
  service: Schema.String,
  version: Schema.String,
  discoveryUrl: Schema.String,
  defaultHeaders: Schema.NullOr(StringMapSchema),
  scopes: Schema.Array(Schema.String),
  auth: GoogleDiscoveryConnectionAuthSchema,
});

export const GoogleDiscoveryStartOAuthInputSchema = Schema.Struct({
  service: Schema.String,
  version: Schema.String,
  discoveryUrl: Schema.NullOr(Schema.String),
  defaultHeaders: Schema.NullOr(StringMapSchema),
  scopes: Schema.Array(Schema.String),
  clientId: Schema.String,
  clientSecretRef: Schema.NullOr(SecretRefSchema),
  clientAuthentication: GoogleDiscoveryOAuthClientAuthenticationSchema,
  redirectUrl: Schema.String,
});

export const GoogleDiscoveryBatchSourceInputSchema = Schema.Struct({
  name: Schema.String,
  service: Schema.String,
  version: Schema.String,
  discoveryUrl: Schema.NullOr(Schema.String),
  defaultHeaders: Schema.NullOr(StringMapSchema),
  scopes: Schema.Array(Schema.String),
});

export const GoogleDiscoveryStartBatchOAuthInputSchema = Schema.Struct({
  sources: Schema.Array(GoogleDiscoveryBatchSourceInputSchema),
  clientId: Schema.String,
  clientSecretRef: Schema.NullOr(SecretRefSchema),
  clientAuthentication: GoogleDiscoveryOAuthClientAuthenticationSchema,
  redirectUrl: Schema.String,
});

export const GoogleDiscoveryStartOAuthResultSchema = Schema.Struct({
  sessionId: Schema.String,
  authorizationUrl: Schema.String,
  scopes: Schema.Array(Schema.String),
});

const GoogleDiscoverySingleOAuthSessionSchema = Schema.Struct({
  kind: Schema.Literal("single"),
  service: Schema.String,
  version: Schema.String,
  discoveryUrl: Schema.String,
  defaultHeaders: Schema.NullOr(StringMapSchema),
  scopes: Schema.Array(Schema.String),
  clientId: Schema.String,
  clientSecretRef: Schema.NullOr(SecretRefSchema),
  clientAuthentication: GoogleDiscoveryOAuthClientAuthenticationSchema,
  redirectUrl: Schema.String,
  codeVerifier: Schema.String,
});

const GoogleDiscoveryBatchOAuthSessionSourceSchema = Schema.Struct({
  name: Schema.String,
  service: Schema.String,
  version: Schema.String,
  discoveryUrl: Schema.String,
  defaultHeaders: Schema.NullOr(StringMapSchema),
  scopes: Schema.Array(Schema.String),
});

const GoogleDiscoveryBatchOAuthSessionSchema = Schema.Struct({
  kind: Schema.Literal("batch"),
  sources: Schema.Array(GoogleDiscoveryBatchOAuthSessionSourceSchema),
  scopes: Schema.Array(Schema.String),
  clientId: Schema.String,
  clientSecretRef: Schema.NullOr(SecretRefSchema),
  clientAuthentication: GoogleDiscoveryOAuthClientAuthenticationSchema,
  redirectUrl: Schema.String,
  codeVerifier: Schema.String,
});

export const GoogleDiscoveryOAuthSessionSchema = Schema.Union(
  GoogleDiscoverySingleOAuthSessionSchema,
  GoogleDiscoveryBatchOAuthSessionSchema,
);

const GoogleDiscoveryOAuthPopupSuccessAuthSchema = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  clientId: Schema.String,
  clientSecretRef: Schema.NullOr(SecretRefSchema),
  clientAuthentication: GoogleDiscoveryOAuthClientAuthenticationSchema,
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  scopes: Schema.Array(Schema.String),
  accessTokenRef: SecretRefSchema,
  refreshTokenRef: Schema.NullOr(SecretRefSchema),
  expiresAt: Schema.NullOr(Schema.Number),
});

const GoogleDiscoveryBatchOAuthPopupSourceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export const GoogleDiscoveryOAuthPopupResultSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("executor:oauth-result"),
    ok: Schema.Literal(true),
    sessionId: Schema.String,
    mode: Schema.Literal("single"),
    auth: GoogleDiscoveryOAuthPopupSuccessAuthSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("executor:oauth-result"),
    ok: Schema.Literal(true),
    sessionId: Schema.String,
    mode: Schema.Literal("batch"),
    sources: Schema.Array(GoogleDiscoveryBatchOAuthPopupSourceSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("executor:oauth-result"),
    ok: Schema.Literal(false),
    sessionId: Schema.Null,
    error: Schema.String,
  }),
);

export type GoogleDiscoveryOAuthClientAuthentication =
  typeof GoogleDiscoveryOAuthClientAuthenticationSchema.Type;
export type GoogleDiscoveryConnectionAuth =
  typeof GoogleDiscoveryConnectionAuthSchema.Type;
export type GoogleDiscoveryConnectInput =
  typeof GoogleDiscoveryConnectInputSchema.Type;
export type GoogleDiscoverySourceConfigPayload =
  typeof GoogleDiscoverySourceConfigPayloadSchema.Type;
export type GoogleDiscoveryUpdateSourceInput =
  typeof GoogleDiscoveryUpdateSourceInputSchema.Type;
export type GoogleDiscoveryStoredSourceData =
  typeof GoogleDiscoveryStoredSourceDataSchema.Type;
export type GoogleDiscoveryStartOAuthInput =
  typeof GoogleDiscoveryStartOAuthInputSchema.Type;
export type GoogleDiscoveryBatchSourceInput =
  typeof GoogleDiscoveryBatchSourceInputSchema.Type;
export type GoogleDiscoveryStartBatchOAuthInput =
  typeof GoogleDiscoveryStartBatchOAuthInputSchema.Type;
export type GoogleDiscoveryStartOAuthResult =
  typeof GoogleDiscoveryStartOAuthResultSchema.Type;
export type GoogleDiscoveryOAuthSession =
  typeof GoogleDiscoveryOAuthSessionSchema.Type;
export type GoogleDiscoveryOAuthPopupResult =
  typeof GoogleDiscoveryOAuthPopupResultSchema.Type;

export const defaultGoogleDiscoveryUrl = (
  service: string,
  version: string,
): string =>
  `https://www.googleapis.com/discovery/v1/apis/${encodeURIComponent(service)}/${encodeURIComponent(version)}/rest`;

export const deriveGoogleDiscoveryNamespace = (
  service: string,
): string =>
  `google.${service
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")}`;
