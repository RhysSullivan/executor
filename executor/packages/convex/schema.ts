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
const taskStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("timed_out"),
  v.literal("denied"),
);
const approvalStatus = v.union(v.literal("pending"), v.literal("approved"), v.literal("denied"));
const toolCallStatus = v.union(
  v.literal("requested"),
  v.literal("pending_approval"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("denied"),
);
const policyDecision = v.union(v.literal("allow"), v.literal("require_approval"), v.literal("deny"));
const credentialScope = v.union(v.literal("workspace"), v.literal("actor"));
const credentialProvider = v.union(
  v.literal("managed"),
  v.literal("workos-vault"),
);
const toolSourceType = v.union(v.literal("mcp"), v.literal("openapi"), v.literal("graphql"));

export default defineSchema({
  accounts: defineTable({
    provider: accountProvider,
    providerAccountId: v.string(), // WorkOS user ID or anon_* UUID
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
    .index("by_provider", ["provider", "providerAccountId"]),

  workspaces: defineTable({
    workosOrgId: v.optional(v.string()), // external WorkOS org ID
    organizationId: v.id("organizations"),
    slug: v.string(),
    name: v.string(),
    iconStorageId: v.optional(v.id("_storage")),
    createdByAccountId: v.optional(v.id("accounts")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workos_org_id", ["workosOrgId"])
    .index("by_organization_created", ["organizationId", "createdAt"])
    .index("by_organization_slug", ["organizationId", "slug"])
    .index("by_slug", ["slug"]),

  organizations: defineTable({
    workosOrgId: v.optional(v.string()), // external WorkOS org ID
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
    workosOrgMembershipId: v.optional(v.string()), // external WorkOS membership ID
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
    .index("by_org_billable_status", ["organizationId", "billable", "status"]),

  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.id("accounts"),
    workosOrgMembershipId: v.optional(v.string()), // external WorkOS membership ID
    role: workspaceMemberRole,
    status: workspaceMemberStatus,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_account", ["workspaceId", "accountId"])
    .index("by_account", ["accountId"])
    .index("by_workos_membership_id", ["workosOrgMembershipId"]),

  invites: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.optional(v.id("workspaces")),
    email: v.string(),
    role: orgRole,
    status: inviteStatus,
    providerInviteId: v.optional(v.string()), // external WorkOS invite ID
    invitedByAccountId: v.id("accounts"),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_email_status", ["organizationId", "email", "status"]),

  billingCustomers: defineTable({
    organizationId: v.id("organizations"),
    stripeCustomerId: v.string(), // external Stripe customer ID
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_stripe_customer_id", ["stripeCustomerId"]),

  billingSubscriptions: defineTable({
    organizationId: v.id("organizations"),
    stripeSubscriptionId: v.string(), // external Stripe subscription ID
    stripePriceId: v.string(), // external Stripe price ID
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
    taskId: v.string(), // domain ID: task_<uuid>
    code: v.string(),
    runtimeId: v.string(),
    workspaceId: v.id("workspaces"),
    actorId: v.optional(v.string()), // account._id or anon_<uuid>
    clientId: v.optional(v.string()), // client label: "web", "mcp", etc.
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
    approvalId: v.string(), // domain ID: approval_<uuid>
    taskId: v.string(), // references tasks.taskId (not tasks._id)
    workspaceId: v.id("workspaces"),
    toolPath: v.string(),
    input: v.any(),
    status: approvalStatus,
    reason: v.optional(v.string()),
    reviewerId: v.optional(v.string()), // account._id or anon_<uuid>
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_approval_id", ["approvalId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_status_created", ["workspaceId", "status", "createdAt"]),

  toolCalls: defineTable({
    taskId: v.string(),
    callId: v.string(),
    workspaceId: v.id("workspaces"),
    toolPath: v.string(),
    input: v.any(),
    status: toolCallStatus,
    approvalId: v.optional(v.string()),
    output: v.optional(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_task_call", ["taskId", "callId"])
    .index("by_task_created", ["taskId", "createdAt"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_approval_id", ["approvalId"]),

  taskEvents: defineTable({
    sequence: v.number(),
    taskId: v.string(), // references tasks.taskId (not tasks._id)
    eventName: v.string(),
    type: v.string(),
    payload: v.any(),
    createdAt: v.number(),
  })
    .index("by_task_sequence", ["taskId", "sequence"]),

  accessPolicies: defineTable({
    policyId: v.string(), // domain ID: policy_<uuid>
    workspaceId: v.id("workspaces"),
    actorId: v.optional(v.string()), // account._id or anon_<uuid>
    clientId: v.optional(v.string()), // client label: "web", "mcp", etc.
    toolPathPattern: v.string(),
    decision: policyDecision,
    priority: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_policy_id", ["policyId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"]),

  sourceCredentials: defineTable({
    credentialId: v.string(), // domain ID: cred_<uuid>
    workspaceId: v.id("workspaces"),
    sourceKey: v.string(),
    scope: credentialScope,
    actorId: v.string(), // account._id or anon_<uuid> (required for composite index)
    provider: credentialProvider,
    secretJson: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_source_scope_actor", ["workspaceId", "sourceKey", "scope", "actorId"]),

  toolSources: defineTable({
    sourceId: v.string(), // domain ID: src_<uuid>
    workspaceId: v.id("workspaces"),
    name: v.string(),
    type: toolSourceType,
    config: v.any(),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source_id", ["sourceId"])
    .index("by_workspace_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_name", ["workspaceId", "name"]),

  openApiSpecCache: defineTable({
    specUrl: v.string(),
    storageId: v.id("_storage"),
    version: v.string(),
    sizeBytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_spec_url_version", ["specUrl", "version"]),

  workspaceToolCache: defineTable({
    workspaceId: v.id("workspaces"),
    signature: v.string(),
    storageId: v.id("_storage"),
    /** Per-source .d.ts blobs stored separately (too large for action responses). */
    dtsStorageIds: v.array(v.object({
      sourceKey: v.string(),
      storageId: v.id("_storage"),
    })),
    toolCount: v.number(),
    sizeBytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"]),

  anonymousSessions: defineTable({
    sessionId: v.string(), // domain ID: anon_session_<uuid> or mcp_<uuid>
    workspaceId: v.id("workspaces"),
    actorId: v.string(), // anon_<uuid>
    clientId: v.string(), // client label: "web", "mcp", etc.
    accountId: v.id("accounts"),
    userId: v.id("workspaceMembers"),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_workspace_actor", ["workspaceId", "actorId"])
    .index("by_account", ["accountId"]),

  // ── Anonymous OAuth: Self-issued auth server for anonymous MCP clients ────

  /**
   * Signing key pair for the self-issued anonymous OAuth server.
   * Persisted so tokens survive gateway restarts.
   * Typically only one "active" row at a time.
   */
  anonymousOauthSigningKeys: defineTable({
    keyId: v.string(), // kid claim: anon_key_<short-uuid>
    algorithm: v.string(), // e.g. "RS256"
    /** JWK-encoded private key (JSON object). */
    privateKeyJwk: v.any(),
    /** JWK-encoded public key (JSON object). */
    publicKeyJwk: v.any(),
    status: v.union(v.literal("active"), v.literal("rotated")),
    createdAt: v.number(),
    rotatedAt: v.optional(v.number()),
  })
    .index("by_key_id", ["keyId"])
    .index("by_status", ["status"]),

  /**
   * Dynamic client registrations (RFC 7591) for the anonymous OAuth flow.
   * Persisted so MCP clients don't need to re-register after a gateway restart.
   */
  anonymousOauthClients: defineTable({
    clientId: v.string(), // domain ID: anon_client_<uuid>
    clientName: v.optional(v.string()),
    redirectUris: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_client_id", ["clientId"]),
});
