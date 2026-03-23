import {
  ExecutionInteractionIdSchema,
  JsonObjectSchema,
  ProviderAuthGrantIdSchema,
  SourceAuthSchema,
  SourceDiscoveryResultSchema,
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

export const DiscoverSourcePayloadSchema = Schema.Struct({
  url: TrimmedNonEmptyStringSchema,
  probeAuth: Schema.optional(SourceProbeAuthSchema),
});

export type DiscoverSourcePayload = typeof DiscoverSourcePayloadSchema.Type;

export {
  SourceDiscoveryResultSchema,
  ScopeIdSchema,
  ScopeOauthClientSchema,
};
