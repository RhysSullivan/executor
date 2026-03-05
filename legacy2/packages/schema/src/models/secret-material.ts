import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import {
  AccountIdSchema,
  AuthConnectionIdSchema,
  OrganizationIdSchema,
  WorkspaceIdSchema,
} from "../ids";

export const SecretMaterialSchema = Schema.Struct({
  handle: Schema.String,
  backend: Schema.String,
  organizationId: OrganizationIdSchema,
  workspaceId: Schema.NullOr(WorkspaceIdSchema),
  accountId: Schema.NullOr(AccountIdSchema),
  connectionId: AuthConnectionIdSchema,
  purpose: Schema.String,
  material: Schema.String,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type SecretMaterial = typeof SecretMaterialSchema.Type;
