import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "@effect/platform";
import * as Schema from "effect/Schema";

import {
  ScopeIdSchema,
  SecretRefSchema,
} from "@executor/platform-sdk/schema";

export const ONEPASSWORD_SECRET_STORE_KIND = "onepassword";
export const ONEPASSWORD_SECRET_FIELD_ID = "credential";

export const OnePasswordStoreAuthSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("desktop-app"),
    accountName: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("service-account"),
    tokenSecretRef: SecretRefSchema,
  }),
);

export const OnePasswordConnectInputSchema = Schema.Struct({
  kind: Schema.Literal(ONEPASSWORD_SECRET_STORE_KIND),
  name: Schema.String,
  vaultId: Schema.String,
  auth: OnePasswordStoreAuthSchema,
});

export const OnePasswordStoreConfigPayloadSchema = OnePasswordConnectInputSchema;

export const OnePasswordUpdateStoreInputSchema = Schema.Struct({
  storeId: Schema.String,
  config: OnePasswordStoreConfigPayloadSchema,
});

export const OnePasswordStoredStoreDataSchema = Schema.Struct({
  vaultId: Schema.String,
  auth: OnePasswordStoreAuthSchema,
});

export const OnePasswordDiscoverVaultsInputSchema = Schema.Struct({
  auth: OnePasswordStoreAuthSchema,
});

export const OnePasswordVaultSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export const OnePasswordDiscoverVaultsResultSchema = Schema.Struct({
  vaults: Schema.Array(OnePasswordVaultSchema),
});

export const OnePasswordDiscoverStoreItemsInputSchema = Schema.Struct({
  storeId: Schema.String,
});

export const OnePasswordItemFieldSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  fieldType: Schema.String,
  sectionId: Schema.optional(Schema.String),
});

export const OnePasswordItemSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  category: Schema.String,
  fields: Schema.optional(Schema.Array(OnePasswordItemFieldSchema)),
});

export const OnePasswordDiscoverStoreItemsResultSchema = Schema.Struct({
  items: Schema.Array(OnePasswordItemSchema),
});

export const OnePasswordDiscoverItemFieldsInputSchema = Schema.Struct({
  storeId: Schema.String,
  itemId: Schema.String,
});

export const OnePasswordDiscoverItemFieldsResultSchema = Schema.Struct({
  itemId: Schema.String,
  fields: Schema.Array(OnePasswordItemFieldSchema),
});

export const OnePasswordImportSecretInputSchema = Schema.Struct({
  storeId: Schema.String,
  itemId: Schema.String,
  fieldId: Schema.String,
  name: Schema.optional(Schema.String),
});

export const OnePasswordImportSecretResultSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  storeId: Schema.String,
  purpose: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

const workspaceIdParam = HttpApiSchema.param("workspaceId", ScopeIdSchema);

export const onePasswordHttpGroup = HttpApiGroup.make("onepassword")
  .add(
    HttpApiEndpoint.post("discoverVaults")`/workspaces/${workspaceIdParam}/plugins/onepassword/vaults/discover`
      .setPayload(OnePasswordDiscoverVaultsInputSchema)
      .addSuccess(OnePasswordDiscoverVaultsResultSchema),
  )
  .add(
    HttpApiEndpoint.post("discoverStoreItems")`/workspaces/${workspaceIdParam}/plugins/onepassword/stores/discover-items`
      .setPayload(OnePasswordDiscoverStoreItemsInputSchema)
      .addSuccess(OnePasswordDiscoverStoreItemsResultSchema),
  )
  .add(
    HttpApiEndpoint.post("discoverItemFields")`/workspaces/${workspaceIdParam}/plugins/onepassword/items/discover-fields`
      .setPayload(OnePasswordDiscoverItemFieldsInputSchema)
      .addSuccess(OnePasswordDiscoverItemFieldsResultSchema),
  )
  .add(
    HttpApiEndpoint.post("importSecret")`/workspaces/${workspaceIdParam}/plugins/onepassword/secrets/import`
      .setPayload(OnePasswordImportSecretInputSchema)
      .addSuccess(OnePasswordImportSecretResultSchema),
  )
  .prefix("/v1");

export const onePasswordHttpApiExtension = {
  key: "onepassword",
  group: onePasswordHttpGroup,
} as const;

export type OnePasswordStoreAuth = typeof OnePasswordStoreAuthSchema.Type;
export type OnePasswordConnectInput = typeof OnePasswordConnectInputSchema.Type;
export type OnePasswordStoreConfigPayload =
  typeof OnePasswordStoreConfigPayloadSchema.Type;
export type OnePasswordUpdateStoreInput =
  typeof OnePasswordUpdateStoreInputSchema.Type;
export type OnePasswordStoredStoreData =
  typeof OnePasswordStoredStoreDataSchema.Type;
export type OnePasswordDiscoverVaultsInput =
  typeof OnePasswordDiscoverVaultsInputSchema.Type;
export type OnePasswordVault = typeof OnePasswordVaultSchema.Type;
export type OnePasswordDiscoverVaultsResult =
  typeof OnePasswordDiscoverVaultsResultSchema.Type;
export type OnePasswordDiscoverStoreItemsInput =
  typeof OnePasswordDiscoverStoreItemsInputSchema.Type;
export type OnePasswordItemField = typeof OnePasswordItemFieldSchema.Type;
export type OnePasswordItem = typeof OnePasswordItemSchema.Type;
export type OnePasswordDiscoverStoreItemsResult =
  typeof OnePasswordDiscoverStoreItemsResultSchema.Type;
export type OnePasswordDiscoverItemFieldsInput =
  typeof OnePasswordDiscoverItemFieldsInputSchema.Type;
export type OnePasswordDiscoverItemFieldsResult =
  typeof OnePasswordDiscoverItemFieldsResultSchema.Type;
export type OnePasswordImportSecretInput =
  typeof OnePasswordImportSecretInputSchema.Type;
export type OnePasswordImportSecretResult =
  typeof OnePasswordImportSecretResultSchema.Type;
