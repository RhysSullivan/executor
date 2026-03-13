import { Schema } from "effect";

export const AccountIdSchema = Schema.String.pipe(Schema.brand("AccountId"));
export const WorkspaceIdSchema = Schema.String.pipe(Schema.brand("WorkspaceId"));
export const SourceIdSchema = Schema.String.pipe(Schema.brand("SourceId"));
export const SourceRecipeIdSchema = Schema.String.pipe(Schema.brand("SourceRecipeId"));
export const SourceRecipeRevisionIdSchema = Schema.String.pipe(
  Schema.brand("SourceRecipeRevisionId"),
);
export const SourceRecipeSchemaBundleIdSchema = Schema.String.pipe(
  Schema.brand("SourceRecipeSchemaBundleId"),
);
export const SourceAuthSessionIdSchema = Schema.String.pipe(
  Schema.brand("SourceAuthSessionId"),
);
export const AuthArtifactIdSchema = Schema.String.pipe(
  Schema.brand("AuthArtifactId"),
);
export const AuthLeaseIdSchema = Schema.String.pipe(
  Schema.brand("AuthLeaseId"),
);
export const CredentialIdSchema = AuthArtifactIdSchema;
export const WorkspaceSourceOauthClientIdSchema = Schema.String.pipe(
  Schema.brand("WorkspaceSourceOauthClientId"),
);
export const SecretMaterialIdSchema = Schema.String.pipe(
  Schema.brand("SecretMaterialId"),
);
export const PolicyIdSchema = Schema.String.pipe(Schema.brand("PolicyId"));
export const ExecutionIdSchema = Schema.String.pipe(Schema.brand("ExecutionId"));
export const ExecutionInteractionIdSchema = Schema.String.pipe(
  Schema.brand("ExecutionInteractionId"),
);
export const ExecutionStepIdSchema = Schema.String.pipe(
  Schema.brand("ExecutionStepId"),
);

export type AccountId = typeof AccountIdSchema.Type;
export type WorkspaceId = typeof WorkspaceIdSchema.Type;
export type SourceId = typeof SourceIdSchema.Type;
export type SourceRecipeId = typeof SourceRecipeIdSchema.Type;
export type SourceRecipeRevisionId = typeof SourceRecipeRevisionIdSchema.Type;
export type SourceRecipeSchemaBundleId = typeof SourceRecipeSchemaBundleIdSchema.Type;
export type SourceAuthSessionId = typeof SourceAuthSessionIdSchema.Type;
export type AuthArtifactId = typeof AuthArtifactIdSchema.Type;
export type AuthLeaseId = typeof AuthLeaseIdSchema.Type;
export type CredentialId = typeof CredentialIdSchema.Type;
export type WorkspaceSourceOauthClientId = typeof WorkspaceSourceOauthClientIdSchema.Type;
export type SecretMaterialId = typeof SecretMaterialIdSchema.Type;
export type PolicyId = typeof PolicyIdSchema.Type;
export type ExecutionId = typeof ExecutionIdSchema.Type;
export type ExecutionInteractionId = typeof ExecutionInteractionIdSchema.Type;
export type ExecutionStepId = typeof ExecutionStepIdSchema.Type;
