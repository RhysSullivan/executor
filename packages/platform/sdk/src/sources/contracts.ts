import {
  ExecutionInteractionIdSchema,
  JsonObjectSchema,
  ProviderAuthGrantIdSchema,
  SourceAuthSchema,
  SourceAuthSessionIdSchema,
  SourceDiscoveryResultSchema,
  SourceIdSchema,
  SourceImportAuthPolicySchema,
  SourceKindSchema,
  SourceProbeAuthSchema,
  SourceSchema,
  SourceStatusSchema,
  SourceOauthClientInputSchema,
  ScopeIdSchema,
  ScopeOauthClientIdSchema,
  ScopeOauthClientSchema,
} from "../schema";
import * as Schema from "effect/Schema";
import {
  ConnectHttpAuthSchema,
  ConnectHttpImportAuthSchema,
  ConnectHttpOauth2SetupSchema,
  ConnectOauthClientSchema,
  McpConnectFieldsSchema,
  OptionalNullableStringSchema,
  SourceConnectCommonFieldsSchema,
} from "@executor/source-core";

import {
  OptionalTrimmedNonEmptyStringSchema,
  TrimmedNonEmptyStringSchema,
} from "../string-schemas";

const createSourcePayloadRequiredSchema = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  kind: SourceKindSchema,
  endpoint: TrimmedNonEmptyStringSchema,
});

const createSourcePayloadOptionalSchema = Schema.Struct({
  status: Schema.optional(SourceStatusSchema),
  enabled: Schema.optional(Schema.Boolean),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  binding: Schema.optional(JsonObjectSchema),
  importAuthPolicy: Schema.optional(SourceImportAuthPolicySchema),
  importAuth: Schema.optional(SourceAuthSchema),
  auth: Schema.optional(SourceAuthSchema),
  sourceHash: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
});

export const CreateSourcePayloadSchema = Schema.extend(
  createSourcePayloadRequiredSchema,
  createSourcePayloadOptionalSchema,
);

export type CreateSourcePayload = typeof CreateSourcePayloadSchema.Type;

export const UpdateSourcePayloadSchema = Schema.Struct({
  name: OptionalTrimmedNonEmptyStringSchema,
  endpoint: OptionalTrimmedNonEmptyStringSchema,
  status: Schema.optional(SourceStatusSchema),
  enabled: Schema.optional(Schema.Boolean),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  binding: Schema.optional(JsonObjectSchema),
  importAuthPolicy: Schema.optional(SourceImportAuthPolicySchema),
  importAuth: Schema.optional(SourceAuthSchema),
  auth: Schema.optional(SourceAuthSchema),
  sourceHash: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
});

export type UpdateSourcePayload = typeof UpdateSourcePayloadSchema.Type;

export const CredentialPageUrlParamsSchema = Schema.Struct({
  interactionId: ExecutionInteractionIdSchema,
});

export const CredentialSubmitPayloadSchema = Schema.Struct({
  action: Schema.optional(Schema.Literal("submit", "continue", "cancel")),
  token: Schema.optional(Schema.String),
});

export const CredentialOauthCompleteUrlParamsSchema = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

export const ScopeOauthClientQuerySchema = Schema.Struct({
  providerKey: Schema.String,
});

export const CreateScopeOauthClientPayloadSchema = Schema.Struct({
  providerKey: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  oauthClient: SourceOauthClientInputSchema,
});

export type CreateScopeOauthClientPayload =
  typeof CreateScopeOauthClientPayloadSchema.Type;

export const oauthClientIdParam = ScopeOauthClientIdSchema;
export const grantIdParam = ProviderAuthGrantIdSchema;

const ConnectGoogleDiscoveryBatchSourceSchema = Schema.Struct({
  service: TrimmedNonEmptyStringSchema,
  version: TrimmedNonEmptyStringSchema,
  discoveryUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  scopes: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ConnectSourceBatchPayloadSchema = Schema.Struct({
  scopeOauthClientId: ScopeOauthClientIdSchema,
  sources: Schema.Array(ConnectGoogleDiscoveryBatchSourceSchema),
});

export type ConnectSourceBatchPayload = typeof ConnectSourceBatchPayloadSchema.Type;

export const ConnectSourceBatchResultSchema = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      source: SourceSchema,
      status: Schema.Literal("connected", "pending_oauth"),
    }),
  ),
  providerOauthSession: Schema.NullOr(
    Schema.Struct({
      sessionId: SourceAuthSessionIdSchema,
      authorizationUrl: Schema.String,
      sourceIds: Schema.Array(SourceIdSchema),
    }),
  ),
});

export type ConnectSourceBatchResult = typeof ConnectSourceBatchResultSchema.Type;

export const DiscoverSourcePayloadSchema = Schema.Struct({
  url: TrimmedNonEmptyStringSchema,
  probeAuth: Schema.optional(SourceProbeAuthSchema),
});

export type DiscoverSourcePayload = typeof DiscoverSourcePayloadSchema.Type;

const OpenApiConnectSourcePayloadSchema = Schema.extend(
  SourceConnectCommonFieldsSchema,
  Schema.extend(
    ConnectHttpImportAuthSchema,
    Schema.Struct({
      kind: Schema.Literal("openapi"),
      specUrl: TrimmedNonEmptyStringSchema,
      auth: Schema.optional(ConnectHttpAuthSchema),
      oauthClient: ConnectOauthClientSchema,
      oauth2Setup: ConnectHttpOauth2SetupSchema,
    }),
  ),
);

const GraphqlConnectSourcePayloadSchema = Schema.extend(
  SourceConnectCommonFieldsSchema,
  Schema.extend(
    ConnectHttpImportAuthSchema,
    Schema.Struct({
      kind: Schema.Literal("graphql"),
      auth: Schema.optional(ConnectHttpAuthSchema),
      oauthClient: ConnectOauthClientSchema,
      oauth2Setup: ConnectHttpOauth2SetupSchema,
    }),
  ),
);

const GoogleDiscoveryConnectSourcePayloadSchema = Schema.extend(
  ConnectHttpImportAuthSchema,
  Schema.Struct({
    kind: Schema.Literal("google_discovery"),
    service: TrimmedNonEmptyStringSchema,
    version: TrimmedNonEmptyStringSchema,
    discoveryUrl: Schema.optional(
      Schema.NullOr(TrimmedNonEmptyStringSchema),
    ),
    scopes: Schema.optional(
      Schema.Array(TrimmedNonEmptyStringSchema),
    ),
    scopeOauthClientId: Schema.optional(
      Schema.NullOr(ScopeOauthClientIdSchema),
    ),
    oauthClient: ConnectOauthClientSchema,
    name: OptionalNullableStringSchema,
    namespace: OptionalNullableStringSchema,
    auth: Schema.optional(ConnectHttpAuthSchema),
  }),
);

const McpConnectSourcePayloadSchema = Schema.extend(
  McpConnectFieldsSchema,
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    endpoint: OptionalNullableStringSchema,
    name: OptionalNullableStringSchema,
    namespace: OptionalNullableStringSchema,
  }),
);

export const ConnectSourcePayloadSchema = Schema.Union(
  OpenApiConnectSourcePayloadSchema,
  GraphqlConnectSourcePayloadSchema,
  GoogleDiscoveryConnectSourcePayloadSchema,
  McpConnectSourcePayloadSchema,
);

export type ConnectSourcePayload = typeof ConnectSourcePayloadSchema.Type;

export const ConnectSourceResultSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("connected"),
    source: SourceSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("credential_required"),
    source: SourceSchema,
    credentialSlot: Schema.Literal("runtime", "import"),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth_required"),
    source: SourceSchema,
    sessionId: SourceAuthSessionIdSchema,
    authorizationUrl: Schema.String,
  }),
);

export type ConnectSourceResult = typeof ConnectSourceResultSchema.Type;

export {
  SourceDiscoveryResultSchema,
  ScopeIdSchema,
  ScopeOauthClientSchema,
};
