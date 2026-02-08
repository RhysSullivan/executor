import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tasks: defineTable({
    taskId: v.string(),
    code: v.string(),
    runtimeId: v.string(),
    workspaceId: v.string(),
    actorId: v.string(),
    clientId: v.string(),
    status: v.string(),
    timeoutMs: v.number(),
    metadata: v.any(),
    error: v.optional(v.string()),
    stdout: v.optional(v.string()),
    stderr: v.optional(v.string()),
    exitCode: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_task_id", ["taskId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_status_created", ["status", "createdAt"]),

  approvals: defineTable({
    approvalId: v.string(),
    taskId: v.string(),
    workspaceId: v.string(),
    toolPath: v.string(),
    input: v.any(),
    status: v.string(),
    reason: v.optional(v.string()),
    reviewerId: v.optional(v.string()),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_approval_id", ["approvalId"])
    .index("by_task", ["taskId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_status_created", ["workspaceId", "status", "createdAt"]),

  taskEvents: defineTable({
    sequence: v.number(),
    taskId: v.string(),
    eventName: v.string(),
    type: v.string(),
    payload: v.any(),
    createdAt: v.number(),
  })
    .index("by_sequence", ["sequence"])
    .index("by_task_sequence", ["taskId", "sequence"]),

  accessPolicies: defineTable({
    policyId: v.string(),
    workspaceId: v.string(),
    actorId: v.string(),
    clientId: v.string(),
    toolPathPattern: v.string(),
    decision: v.string(),
    priority: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_policy_id", ["policyId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"]),

  sourceCredentials: defineTable({
    credentialId: v.string(),
    workspaceId: v.string(),
    sourceKey: v.string(),
    scope: v.string(),
    actorId: v.string(),
    secretJson: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_credential_id", ["credentialId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_source_scope_actor", ["workspaceId", "sourceKey", "scope", "actorId"]),

  toolSources: defineTable({
    sourceId: v.string(),
    workspaceId: v.string(),
    name: v.string(),
    type: v.string(),
    config: v.any(),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source_id", ["sourceId"])
    .index("by_workspace_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_name", ["workspaceId", "name"])
    .index("by_workspace_enabled_updated", ["workspaceId", "enabled", "updatedAt"]),

  anonymousSessions: defineTable({
    sessionId: v.string(),
    workspaceId: v.string(),
    actorId: v.string(),
    clientId: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_workspace_actor", ["workspaceId", "actorId"]),

  workspaceTools: defineTable({
    workspaceId: v.string(),
    path: v.string(),
    description: v.string(),
    approval: v.string(),
    source: v.optional(v.string()),
    argsType: v.optional(v.string()),
    returnsType: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_workspace_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_path", ["workspaceId", "path"]),
});
