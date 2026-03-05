import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import {
  StorageDurabilitySchema,
  StorageInstanceStatusSchema,
  StorageProviderSchema,
  StorageScopeTypeSchema,
} from "../enums";
import {
  AccountIdSchema,
  OrganizationIdSchema,
  StorageInstanceIdSchema,
  WorkspaceIdSchema,
} from "../ids";

export const StorageInstanceSchema = Schema.Struct({
  id: StorageInstanceIdSchema,
  scopeType: StorageScopeTypeSchema,
  durability: StorageDurabilitySchema,
  status: StorageInstanceStatusSchema,
  provider: StorageProviderSchema,
  backendKey: Schema.String,
  organizationId: OrganizationIdSchema,
  workspaceId: Schema.NullOr(WorkspaceIdSchema),
  accountId: Schema.NullOr(AccountIdSchema),
  createdByAccountId: Schema.NullOr(AccountIdSchema),
  purpose: Schema.NullOr(Schema.String),
  sizeBytes: Schema.NullOr(Schema.Number),
  fileCount: Schema.NullOr(Schema.Number),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
  lastSeenAt: TimestampMsSchema,
  closedAt: Schema.NullOr(TimestampMsSchema),
  expiresAt: Schema.NullOr(TimestampMsSchema),
});

export type StorageInstance = typeof StorageInstanceSchema.Type;
