import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { CredentialProviderSchema, CredentialScopeTypeSchema } from "../enums";
import {
  AccountIdSchema,
  CredentialBindingIdSchema,
  CredentialIdSchema,
  OrganizationIdSchema,
  WorkspaceIdSchema,
} from "../ids";

export const SourceCredentialBindingSchema = Schema.Struct({
  id: CredentialBindingIdSchema,
  credentialId: CredentialIdSchema,
  organizationId: OrganizationIdSchema,
  workspaceId: Schema.NullOr(WorkspaceIdSchema),
  accountId: Schema.NullOr(AccountIdSchema),
  scopeType: CredentialScopeTypeSchema,
  sourceKey: Schema.String,
  provider: CredentialProviderSchema,
  secretRef: Schema.String,
  additionalHeadersJson: Schema.NullOr(Schema.String),
  boundAuthFingerprint: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type SourceCredentialBinding = typeof SourceCredentialBindingSchema.Type;
