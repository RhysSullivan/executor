import {
  Schema,
} from "effect";

import {
  TimestampMsSchema,
} from "../common";
import {
  ScopeIdSchema,
  SecretStoreIdSchema,
} from "../ids";

export const SecretStoreKindSchema = Schema.String;

export const SecretStoreStatusSchema = Schema.Literal(
  "connected",
  "error",
);

export const SecretStoreSchema = Schema.Struct({
  id: SecretStoreIdSchema,
  scopeId: ScopeIdSchema,
  name: Schema.String,
  kind: SecretStoreKindSchema,
  status: SecretStoreStatusSchema,
  enabled: Schema.Boolean,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type SecretStoreKind = typeof SecretStoreKindSchema.Type;
export type SecretStoreStatus = typeof SecretStoreStatusSchema.Type;
export type SecretStore = typeof SecretStoreSchema.Type;
