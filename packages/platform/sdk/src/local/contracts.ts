import {
  SecretMaterialPurposeSchema,
} from "../schema";
import * as Schema from "effect/Schema";

export const SecretProviderSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  canStore: Schema.Boolean,
});

export const InstanceConfigSchema = Schema.Struct({
  platform: Schema.String,
  secretProviders: Schema.Array(SecretProviderSchema),
  defaultSecretStoreProvider: Schema.String,
});

export type SecretProvider = typeof SecretProviderSchema.Type;
export type InstanceConfig = typeof InstanceConfigSchema.Type;

export const SecretLinkedSourceSchema = Schema.Struct({
  sourceId: Schema.String,
  sourceName: Schema.String,
});

export type SecretLinkedSource = typeof SecretLinkedSourceSchema.Type;

export const SecretListItemSchema = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  name: Schema.NullOr(Schema.String),
  purpose: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  linkedSources: Schema.Array(SecretLinkedSourceSchema),
});

export type SecretListItem = typeof SecretListItemSchema.Type;

export const CreateSecretPayloadSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  purpose: Schema.optional(SecretMaterialPurposeSchema),
  providerId: Schema.optional(Schema.String),
});

export type CreateSecretPayload = typeof CreateSecretPayloadSchema.Type;

export const CreateSecretResultSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  providerId: Schema.String,
  purpose: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export type CreateSecretResult = typeof CreateSecretResultSchema.Type;

export const UpdateSecretPayloadSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
});

export type UpdateSecretPayload = typeof UpdateSecretPayloadSchema.Type;

export const UpdateSecretResultSchema = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  name: Schema.NullOr(Schema.String),
  purpose: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export type UpdateSecretResult = typeof UpdateSecretResultSchema.Type;

export const DeleteSecretResultSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export type DeleteSecretResult = typeof DeleteSecretResultSchema.Type;
