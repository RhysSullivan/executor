import { defineSchema, defineTable, type TablesFromSchemaDefinition } from "@executor-v2/confect";
import {
  ApprovalSchema,
  EventEnvelopeSchema,
  OAuthTokenSchema,
  OrganizationMembershipSchema,
  OrganizationSchema,
  PolicySchema,
  ProfileSchema,
  SourceCredentialBindingSchema,
  SourceSchema,
  SyncStateSchema,
  TaskRunSchema,
  ToolArtifactSchema,
  WorkspaceSchema,
} from "@executor-v2/schema";

export const executorConfectSchema = defineSchema({
  profiles: defineTable(ProfileSchema).index("by_domainId", ["id"]),
  organizations: defineTable(OrganizationSchema)
    .index("by_domainId", ["id"])
    .index("by_slug", ["slug"]),
  organizationMemberships: defineTable(OrganizationMembershipSchema)
    .index("by_domainId", ["id"])
    .index("by_organizationId", ["organizationId"])
    .index("by_accountId", ["accountId"])
    .index("by_organizationId_accountId", ["organizationId", "accountId"]),
  workspaces: defineTable(WorkspaceSchema)
    .index("by_domainId", ["id"])
    .index("by_organizationId", ["organizationId"]),
  sources: defineTable(SourceSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"]),
  toolArtifacts: defineTable(ToolArtifactSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_sourceId", ["sourceId"]),
  sourceCredentialBindings: defineTable(SourceCredentialBindingSchema)
    .index("by_domainId", ["id"])
    .index("by_credentialId", ["credentialId"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_organizationId", ["organizationId"])
    .index("by_accountId", ["accountId"])
    .index("by_sourceKey", ["sourceKey"]),
  oauthTokens: defineTable(OAuthTokenSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_organizationId", ["organizationId"])
    .index("by_accountId", ["accountId"])
    .index("by_sourceId", ["sourceId"]),
  policies: defineTable(PolicySchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"]),
  approvals: defineTable(ApprovalSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_taskRunId", ["taskRunId"]),
  taskRuns: defineTable(TaskRunSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_sessionId", ["sessionId"]),
  syncStates: defineTable(SyncStateSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"]),
  events: defineTable(EventEnvelopeSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_workspaceId_sequence", ["workspaceId", "sequence"]),
});

export type ExecutorConfectTables = TablesFromSchemaDefinition<typeof executorConfectSchema>;

export default executorConfectSchema.convexSchemaDefinition;
