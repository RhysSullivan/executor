import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { CredentialModeSchema } from "../enums";
import { CredentialRefIdSchema, SourceIdSchema, WorkspaceIdSchema } from "../ids";

export const CredentialRefSchema = Schema.Struct({
  id: CredentialRefIdSchema,
  workspaceId: WorkspaceIdSchema,
  sourceId: SourceIdSchema,
  mode: CredentialModeSchema,
  label: Schema.String,
  secretRef: Schema.String,
  headerName: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type CredentialRef = typeof CredentialRefSchema.Type;
