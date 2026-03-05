import { Schema } from "effect";

export const AccountIdSchema = Schema.String.pipe(Schema.brand("AccountId"));
export const OrganizationIdSchema = Schema.String.pipe(Schema.brand("OrganizationId"));
export const OrganizationMemberIdSchema = Schema.String.pipe(
  Schema.brand("OrganizationMemberId"),
);
export const WorkspaceIdSchema = Schema.String.pipe(Schema.brand("WorkspaceId"));
export const SourceIdSchema = Schema.String.pipe(Schema.brand("SourceId"));
export const PolicyIdSchema = Schema.String.pipe(Schema.brand("PolicyId"));

export type AccountId = typeof AccountIdSchema.Type;
export type OrganizationId = typeof OrganizationIdSchema.Type;
export type OrganizationMemberId = typeof OrganizationMemberIdSchema.Type;
export type WorkspaceId = typeof WorkspaceIdSchema.Type;
export type SourceId = typeof SourceIdSchema.Type;
export type PolicyId = typeof PolicyIdSchema.Type;
