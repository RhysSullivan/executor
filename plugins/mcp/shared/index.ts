import * as Schema from "effect/Schema";

import {
  SecretRefSchema,
} from "@executor/platform-sdk/schema";
import {
  JsonObjectSchema,
  SourceDiscoveryResultSchema,
  SourceProbeAuthSchema,
  SourceTransportSchema,
  StringArraySchema,
  StringMapSchema,
  defaultNameFromEndpoint,
  namespaceFromSourceName,
} from "@executor/source-core";

export { getFaviconUrlForRemoteUrl } from "@executor/source-core";

export const McpConnectionAuthSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth2"),
    redirectUri: Schema.String,
    accessTokenRef: SecretRefSchema,
    refreshTokenRef: Schema.NullOr(SecretRefSchema),
    tokenType: Schema.String,
    expiresAt: Schema.NullOr(Schema.Number),
    scope: Schema.NullOr(Schema.String),
    resourceMetadataUrl: Schema.NullOr(Schema.String),
    authorizationServerUrl: Schema.NullOr(Schema.String),
    resourceMetadata: Schema.NullOr(JsonObjectSchema),
    authorizationServerMetadata: Schema.NullOr(JsonObjectSchema),
    clientInformation: Schema.NullOr(JsonObjectSchema),
  }),
);

export const McpConnectInputSchema = Schema.Struct({
  name: Schema.String,
  iconUrl: Schema.optional(Schema.String),
  endpoint: Schema.NullOr(Schema.String),
  transport: Schema.NullOr(SourceTransportSchema),
  queryParams: Schema.NullOr(StringMapSchema),
  headers: Schema.NullOr(StringMapSchema),
  command: Schema.NullOr(Schema.String),
  args: Schema.NullOr(StringArraySchema),
  env: Schema.NullOr(StringMapSchema),
  cwd: Schema.NullOr(Schema.String),
  auth: McpConnectionAuthSchema,
});

export const McpSourceConfigPayloadSchema = McpConnectInputSchema;

export const McpUpdateSourceInputSchema = Schema.Struct({
  sourceId: Schema.String,
  config: McpSourceConfigPayloadSchema,
});

export const McpStoredSourceDataSchema = Schema.Struct({
  endpoint: Schema.NullOr(Schema.String),
  transport: Schema.NullOr(SourceTransportSchema),
  queryParams: Schema.NullOr(StringMapSchema),
  headers: Schema.NullOr(StringMapSchema),
  command: Schema.NullOr(Schema.String),
  args: Schema.NullOr(StringArraySchema),
  env: Schema.NullOr(StringMapSchema),
  cwd: Schema.NullOr(Schema.String),
  auth: McpConnectionAuthSchema,
});

export const McpStartOAuthInputSchema = Schema.Struct({
  endpoint: Schema.String,
  queryParams: Schema.NullOr(StringMapSchema),
  redirectUrl: Schema.String,
});

export const McpDiscoverInputSchema = Schema.Struct({
  endpoint: Schema.String,
  probeAuth: Schema.optional(Schema.NullOr(SourceProbeAuthSchema)),
});

export const McpDiscoverResultSchema = Schema.NullOr(SourceDiscoveryResultSchema);

export const McpStartOAuthResultSchema = Schema.Struct({
  sessionId: Schema.String,
  authorizationUrl: Schema.String,
});

export const McpOAuthSessionSchema = Schema.Struct({
  endpoint: Schema.String,
  redirectUrl: Schema.String,
  codeVerifier: Schema.String,
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerUrl: Schema.NullOr(Schema.String),
  resourceMetadata: Schema.NullOr(JsonObjectSchema),
  authorizationServerMetadata: Schema.NullOr(JsonObjectSchema),
  clientInformation: Schema.NullOr(JsonObjectSchema),
});

const McpOAuthPopupAuthSchema = Schema.Struct({
  kind: Schema.Literal("oauth2"),
  redirectUri: Schema.String,
  accessTokenRef: SecretRefSchema,
  refreshTokenRef: Schema.NullOr(SecretRefSchema),
  tokenType: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerUrl: Schema.NullOr(Schema.String),
  resourceMetadata: Schema.NullOr(JsonObjectSchema),
  authorizationServerMetadata: Schema.NullOr(JsonObjectSchema),
  clientInformation: Schema.NullOr(JsonObjectSchema),
});

export const McpOAuthPopupResultSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("executor:oauth-result"),
    ok: Schema.Literal(true),
    sessionId: Schema.String,
    auth: McpOAuthPopupAuthSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("executor:oauth-result"),
    ok: Schema.Literal(false),
    sessionId: Schema.Null,
    error: Schema.String,
  }),
);

export type McpConnectionAuth = typeof McpConnectionAuthSchema.Type;
export type McpConnectInput = typeof McpConnectInputSchema.Type;
export type McpSourceConfigPayload = typeof McpSourceConfigPayloadSchema.Type;
export type McpUpdateSourceInput = typeof McpUpdateSourceInputSchema.Type;
export type McpStoredSourceData = typeof McpStoredSourceDataSchema.Type;
export type McpStartOAuthInput = typeof McpStartOAuthInputSchema.Type;
export type McpStartOAuthResult = typeof McpStartOAuthResultSchema.Type;
export type McpDiscoverInput = typeof McpDiscoverInputSchema.Type;
export type McpDiscoverResult = typeof McpDiscoverResultSchema.Type;
export type McpOAuthSession = typeof McpOAuthSessionSchema.Type;
export type McpOAuthPopupResult = typeof McpOAuthPopupResultSchema.Type;

export const deriveMcpNamespace = (input: {
  name?: string | null;
  endpoint?: string | null;
  command?: string | null;
}): string | null => {
  if (input.name && input.name.trim().length > 0) {
    return namespaceFromSourceName(input.name);
  }

  if (input.endpoint && input.endpoint.trim().length > 0) {
    try {
      return namespaceFromSourceName(defaultNameFromEndpoint(input.endpoint));
    } catch {
      // Fall through to command inference.
    }
  }

  if (input.command && input.command.trim().length > 0) {
    const commandName = input.command.trim().split(/[\\/]/).pop() ?? input.command.trim();
    return namespaceFromSourceName(commandName);
  }

  return null;
};

export const resolveMcpEndpoint = (input: {
  endpoint: string;
  queryParams?: Readonly<Record<string, string>> | null;
}): string => {
  const url = new URL(input.endpoint);
  for (const [key, value] of Object.entries(input.queryParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
};
