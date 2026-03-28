import {
  Schema,
} from "effect";

export const ScopeIdSchema = Schema.String.pipe(Schema.brand("ScopeId"));
export const SourceIdSchema = Schema.String.pipe(Schema.brand("SourceId"));
export const SourceCatalogIdSchema = Schema.String.pipe(Schema.brand("SourceCatalogId"));
export const SourceCatalogRevisionIdSchema = Schema.String.pipe(
  Schema.brand("SourceCatalogRevisionId"),
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

export type ScopeId = typeof ScopeIdSchema.Type;
export type SourceId = typeof SourceIdSchema.Type;
export type SourceCatalogId = typeof SourceCatalogIdSchema.Type;
export type SourceCatalogRevisionId = typeof SourceCatalogRevisionIdSchema.Type;
export type SecretMaterialId = typeof SecretMaterialIdSchema.Type;
export type PolicyId = typeof PolicyIdSchema.Type;
export type ExecutionId = typeof ExecutionIdSchema.Type;
export type ExecutionInteractionId = typeof ExecutionInteractionIdSchema.Type;
export type ExecutionStepId = typeof ExecutionStepIdSchema.Type;
