import { defineSchema, defineTable, type TablesFromSchemaDefinition } from "@executor-v2/confect";
import {
  ApprovalSchema,
  CredentialRefSchema,
  EventEnvelopeSchema,
  OAuthTokenSchema,
  PolicySchema,
  ProfileSchema,
  SourceSchema,
  SyncStateSchema,
  TaskRunSchema,
  ToolArtifactSchema,
  WorkspaceSchema,
} from "@executor-v2/schema";

export const executorConfectSchema = defineSchema({
  profiles: defineTable(ProfileSchema).index("by_domainId", ["id"]),
  workspaces: defineTable(WorkspaceSchema)
    .index("by_domainId", ["id"])
    .index("by_profileId", ["profileId"]),
  sources: defineTable(SourceSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"]),
  toolArtifacts: defineTable(ToolArtifactSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_sourceId", ["sourceId"]),
  credentialRefs: defineTable(CredentialRefSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"])
    .index("by_sourceId", ["sourceId"]),
  oauthTokens: defineTable(OAuthTokenSchema)
    .index("by_domainId", ["id"])
    .index("by_workspaceId", ["workspaceId"])
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
