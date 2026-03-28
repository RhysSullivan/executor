import {
  SecretMaterialPurposeSchema,
} from "../schema";
import * as Schema from "effect/Schema";

export const SecretProviderSchema = Schema.Struct({
  kind: Schema.String,
  displayName: Schema.String,
  canCreate: Schema.Boolean,
});

export const InstanceConfigSchema = Schema.Struct({
  platform: Schema.String,
  secretStorePlugins: Schema.Array(SecretProviderSchema),
  defaultSecretStoreId: Schema.NullOr(Schema.String),
});

export type SecretProvider = typeof SecretProviderSchema.Type;
export type InstanceConfig = typeof InstanceConfigSchema.Type;

export const SecretLinkedSourceSchema = Schema.Struct({
  sourceId: Schema.String,
  sourceName: Schema.String,
});

export type SecretLinkedSource = typeof SecretLinkedSourceSchema.Type;

export const SecretStoreCapabilitiesSchema = Schema.Struct({
  canCreateSecrets: Schema.Boolean,
  canUpdateSecrets: Schema.Boolean,
  canDeleteSecrets: Schema.Boolean,
  canBrowseSecrets: Schema.Boolean,
  canImportSecrets: Schema.Boolean,
});

export type SecretStoreCapabilities = typeof SecretStoreCapabilitiesSchema.Type;

export const SecretListItemSchema = Schema.Struct({
  id: Schema.String,
  storeId: Schema.String,
  storeName: Schema.String,
  storeKind: Schema.String,
  name: Schema.NullOr(Schema.String),
  purpose: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  linkedSources: Schema.Array(SecretLinkedSourceSchema),
});

export type SecretListItem = typeof SecretListItemSchema.Type;

export const CreateSecretPayloadSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  purpose: Schema.optional(SecretMaterialPurposeSchema),
  storeId: Schema.optional(Schema.String),
});

export type CreateSecretPayload = typeof CreateSecretPayloadSchema.Type;

export const CreateSecretResultSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  storeId: Schema.String,
  purpose: Schema.String,
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
  storeId: Schema.String,
  name: Schema.NullOr(Schema.String),
  purpose: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const SecretStoreSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  status: Schema.String,
  enabled: Schema.Boolean,
  capabilities: SecretStoreCapabilitiesSchema,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export type SecretStore = typeof SecretStoreSchema.Type;

export const SecretStoreBrowseEntrySchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
  kind: Schema.Literal("group", "secret"),
});

export type SecretStoreBrowseEntry = typeof SecretStoreBrowseEntrySchema.Type;

export const BrowseSecretStorePayloadSchema = Schema.Struct({
  parentKey: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
});

export type BrowseSecretStorePayload = typeof BrowseSecretStorePayloadSchema.Type;

export const BrowseSecretStoreResultSchema = Schema.Struct({
  entries: Schema.Array(SecretStoreBrowseEntrySchema),
});

export type BrowseSecretStoreResult = typeof BrowseSecretStoreResultSchema.Type;

export const ImportSecretFromStorePayloadSchema = Schema.Struct({
  selectionKey: Schema.String,
  name: Schema.optional(Schema.String),
  purpose: Schema.optional(SecretMaterialPurposeSchema),
});

export type ImportSecretFromStorePayload =
  typeof ImportSecretFromStorePayloadSchema.Type;

export const CreateSecretStorePayloadSchema = Schema.Struct({
  kind: Schema.String,
  name: Schema.String,
  config: Schema.Unknown,
});

export type CreateSecretStorePayload = typeof CreateSecretStorePayloadSchema.Type;

export const UpdateSecretStorePayloadSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  config: Schema.optional(Schema.Unknown),
});

export type UpdateSecretStorePayload = typeof UpdateSecretStorePayloadSchema.Type;

export const DeleteSecretStoreResultSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export type DeleteSecretStoreResult = typeof DeleteSecretStoreResultSchema.Type;

export type UpdateSecretResult = typeof UpdateSecretResultSchema.Type;

export const DeleteSecretResultSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export type DeleteSecretResult = typeof DeleteSecretResultSchema.Type;
