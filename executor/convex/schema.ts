import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const accountProvider = v.union(v.literal("workos"), v.literal("anonymous"));
const accountStatus = v.union(v.literal("active"), v.literal("deleted"));
const organizationStatus = v.union(v.literal("active"), v.literal("deleted"));
const orgRole = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("billing_admin"));
const orgMemberStatus = v.union(v.literal("active"), v.literal("pending"), v.literal("removed"));
const workspaceMemberRole = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"));
const workspaceMemberStatus = v.union(v.literal("active"), v.literal("pending"), v.literal("removed"));
const billingSubscriptionStatus = v.union(
  v.literal("incomplete"),
  v.literal("incomplete_expired"),
  v.literal("trialing"),
  v.literal("active"),
  v.literal("past_due"),
  v.literal("canceled"),
  v.literal("unpaid"),
  v.literal("paused"),
);
const inviteStatus = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("expired"),
  v.literal("revoked"),
  v.literal("failed"),
);
const inviteProvider = v.literal("workos");
const taskStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("timed_out"),
  v.literal("denied"),
);
const approvalStatus = v.union(v.literal("pending"), v.literal("approved"), v.literal("denied"));
const policyDecision = v.union(v.literal("allow"), v.literal("require_approval"), v.literal("deny"));
const credentialScope = v.union(v.literal("workspace"), v.literal("actor"));
const toolSourceType = v.union(v.literal("mcp"), v.literal("openapi"), v.literal("graphql"));
const agentTaskStatus = v.union(v.literal("running"), v.literal("completed"), v.literal("failed"));

export default defineSchema({
  accounts: defineTable({
    provider: accountProvider,
    providerAccountId: v.string(),
    email: v.string(),
    name: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    status: accountStatus,
    createdAt: v.number(),
    updatedAt: v.number(),
    lastLoginAt: v.optional(v.number()),
  })
    .index("by_provider", ["provider", "providerAccountId"])
    .index("by_email", ["email"]),

  workspaces: defineTable({
    workosOrgId: v.optional(v.string()),
    organizationId: v.id("organizations"),
    slug: v.string(),
    name: v.string(),
    iconStorageId: v.optional(v.id("_storage")),
    plan: v.string(),
    createdByAccountId: v.optional(v.id("accounts")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workos_org_id", ["workosOrgId"])
    .index("by_organization_created", ["organizationId", "createdAt"])
    .index("by_organization_slug", ["organizationId", "slug"])
    .index("by_creator_created", ["createdByAccountId", "createdAt"])
    .index("by_slug", ["slug"]),

  organizations: defineTable({
    workosOrgId: v.optional(v.string()),
    slug: v.string(),
    name: v.string(),
    status: organizationStatus,
    createdByAccountId: v.optional(v.id("accounts")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workos_org_id", ["workosOrgId"])
    .index("by_slug", ["slug"])
    .index("by_status_created", ["status", "createdAt"]),

  organizationMembers: defineTable({
    organizationId: v.id("organizations"),
    accountId: v.id("accounts"),
    role: orgRole,
    status: orgMemberStatus,
    billable: v.boolean(),
    invitedByAccountId: v.optional(v.id("accounts")),
    joinedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_account", ["organizationId", "accountId"])
    .index("by_account", ["accountId"])
    .index("by_org_status", ["organizationId", "status"])
    .index("by_org_billable_status", ["organizationId", "billable", "status"]),

  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.id("accounts"),
    workosOrgMembershipId: v.optional(v.string()),
    role: workspaceMemberRole,
    status: workspaceMemberStatus,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_account", ["workspaceId", "accountId"])
    .index("by_account", ["accountId"])
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_workos_membership_id", ["workosOrgMembershipId"]),

  invites: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.optional(v.id("workspaces")),
    email: v.string(),
    role: orgRole,
    status: inviteStatus,
    provider: inviteProvider,
    providerInviteId: v.optional(v.string()),
    invitedByAccountId: v.id("accounts"),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_status_created", ["organizationId", "status", "createdAt"])
    .index("by_org_email_status", ["organizationId", "email", "status"]),

  billingCustomers: defineTable({
    organizationId: v.id("organizations"),
    stripeCustomerId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_stripe_customer_id", ["stripeCustomerId"]),

  billingSubscriptions: defineTable({
    organizationId: v.id("organizations"),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.string(),
    status: billingSubscriptionStatus,
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.boolean(),
    canceledAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_status", ["organizationId", "status"])
    .index("by_stripe_subscription_id", ["stripeSubscriptionId"]),

  billingSeatState: defineTable({
    organizationId: v.id("organizations"),
    desiredSeats: v.number(),
    lastAppliedSeats: v.optional(v.number()),
    syncVersion: v.number(),
    lastSyncAt: v.optional(v.number()),
    syncError: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_org", ["organizationId"]),

  tasks: defineTable({
    taskId: v.string(),
    code: v.string(),
    runtimeId: v.string(),
    workspaceId: v.string(),
    actorId: v.string(),
    clientId: v.string(),
    status: taskStatus,
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
    status: approvalStatus,
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
    decision: policyDecision,
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
    scope: credentialScope,
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
    type: toolSourceType,
    config: v.any(),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source_id", ["sourceId"])
    .index("by_workspace_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_name", ["workspaceId", "name"])
    .index("by_workspace_enabled_updated", ["workspaceId", "enabled", "updatedAt"]),

  agentTasks: defineTable({
    agentTaskId: v.string(),
    prompt: v.string(),
    requesterId: v.string(),
    workspaceId: v.string(),
    actorId: v.string(),
    status: agentTaskStatus,
    resultText: v.optional(v.string()),
    error: v.optional(v.string()),
    codeRuns: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_agent_task_id", ["agentTaskId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_requester_created", ["requesterId", "createdAt"]),

  anonymousSessions: defineTable({
    sessionId: v.string(),
    workspaceId: v.id("workspaces"),
    actorId: v.string(),
    clientId: v.string(),
    accountId: v.optional(v.id("accounts")),
    userId: v.optional(v.id("workspaceMembers")),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_workspace_actor", ["workspaceId", "actorId"])
    .index("by_account", ["accountId"]),
});
