import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Convex database schema.
//
// Conventions used throughout:
// - Most tables have `createdAt` / `updatedAt` as epoch milliseconds.
// - Some tables use a *domain id* string (eg `task_<uuid>`, `approval_<uuid>`) in addition
//   to Convex's built-in `_id`. When present, the domain id is what gets referenced across
//   systems and in logs; `_id` stays internal to Convex.
// - `accountId` links rows to `accounts` where identity context is needed.
//
// The small validators below act like enums for schema fields.
// Note: Some of these are duplicated as request validators under `executor/packages/database/convex/database/validators.ts`
// and in a few feature modules. Keep the literal sets aligned to avoid drift.

const accountProvider = v.union(v.literal("workos"), v.literal("anonymous"));
const accountStatus = v.union(v.literal("active"), v.literal("deleted"));
const organizationStatus = v.union(v.literal("active"), v.literal("deleted"));
const orgRole = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("billing_admin"));
const orgMemberStatus = v.union(v.literal("active"), v.literal("pending"), v.literal("removed"));
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
const toolApprovalMode = v.union(v.literal("auto"), v.literal("required"));
const policyScopeType = v.union(v.literal("account"), v.literal("organization"), v.literal("workspace"));
const policyMatchType = v.union(v.literal("glob"), v.literal("exact"));
const policyEffect = v.union(v.literal("allow"), v.literal("deny"));
const policyApprovalMode = v.union(v.literal("inherit"), v.literal("auto"), v.literal("required"));
const toolRoleSelectorType = v.union(
  v.literal("all"),
  v.literal("source"),
  v.literal("namespace"),
  v.literal("tool_path"),
);
const toolRoleBindingStatus = v.union(v.literal("active"), v.literal("disabled"));
const toolSourceScopeType = v.union(v.literal("organization"), v.literal("workspace"));
const credentialScopeType = v.union(v.literal("account"), v.literal("organization"), v.literal("workspace"));
const credentialProvider = v.union(
  v.literal("local-convex"),
  v.literal("workos-vault"),
);
const toolSourceType = v.union(v.literal("mcp"), v.literal("openapi"), v.literal("graphql"));
const jsonObject = v.record(v.string(), v.any());

export default defineSchema({
  // User identities (WorkOS-backed or anonymous).
  //
  // Primary access patterns:
  // - Lookup by provider + providerAccountId (WorkOS user id / anon id).
  accounts: defineTable({
    provider: accountProvider,
    providerAccountId: v.string(), // WorkOS user ID or anon_* UUID
    email: v.optional(v.string()),
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

  // Workspaces are the main unit of isolation for tasks, tools, and credentials.
  // A workspace always belongs to exactly one `organizations` row.
  //
  // Primary access patterns:
  // - Resolve by slug (global) or by (organizationId, slug).
  // - List workspaces in an org by creation time.
  workspaces: defineTable({
    organizationId: v.id("organizations"),
    slug: v.string(),
    name: v.string(),
    iconStorageId: v.optional(v.id("_storage")),
    createdByAccountId: v.optional(v.id("accounts")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_created", ["organizationId", "createdAt"])
    .index("by_organization_slug", ["organizationId", "slug"])
    .index("by_slug", ["slug"]),

  // Billing / membership umbrella entity.
  // WorkOS organization id is stored here only as an external-link reference.
  //
  // Primary access patterns:
  // - Resolve by slug.
  // - Resolve by WorkOS org id.
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

  // Membership of an account within an organization.
  // `billable` drives seat-count calculations.
  //
  // Primary access patterns:
  // - List members in org.
  // - Get membership for (org, account).
  // - Count billable active members (org, billable, status).
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
    .index("by_org_billable_status", ["organizationId", "billable", "status"]),

  // Organization (and optionally workspace-specific) email invites.
  // Provider-specific invite id is stored once WorkOS invite delivery succeeds.
  //
  // Primary access patterns:
  // - List invites for org.
  // - Find invites by (org, email, status) during acceptance flows.
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

  // Idempotency receipts for incoming provider webhooks.
  // We treat provider events as hints and suppress duplicate payload processing.
  authWebhookReceipts: defineTable({
    provider: v.literal("workos"),
    eventType: v.string(),
    fingerprint: v.string(),
    receivedAt: v.number(),
  })
    .index("by_provider_fingerprint", ["provider", "fingerprint"])
    .index("by_provider_received", ["provider", "receivedAt"]),

  // Stripe customer linkage for an organization.
  //
  // Primary access patterns:
  // - Resolve by organization.
  billingCustomers: defineTable({
    organizationId: v.id("organizations"),
    stripeCustomerId: v.string(), // external Stripe customer ID
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"]),

  // Stripe subscription state for an organization.
  //
  // Primary access patterns:
  // - List subscriptions for an org.
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
    .index("by_org", ["organizationId"]),

  // Seat syncing bookkeeping (eg Stripe per-seat quantity).
  // Stored separately from subscription records so sync logic can be retried/idempotent.
  billingSeatState: defineTable({
    organizationId: v.id("organizations"),
    desiredSeats: v.number(),
    lastAppliedSeats: v.optional(v.number()),
    syncVersion: v.number(),
    lastSyncAt: v.optional(v.number()),
    syncError: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_org", ["organizationId"]),

  // Task executions (code run in a runtime for a workspace).
  // Note: `taskId` is a stable domain id used across systems; `_id` is Convex internal.
  //
  // Primary access patterns:
  // - Resolve by domain task id.
  // - List recent tasks in a workspace.
  // - Poll queues by status.
  tasks: defineTable({
    taskId: v.string(), // domain ID: task_<uuid>
    code: v.string(),
    runtimeId: v.string(),
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()), // client label: "web", "mcp", etc.
    status: taskStatus,
    timeoutMs: v.number(),
    metadata: jsonObject,
    nextEventSequence: v.optional(v.number()),
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

  // Approval records for sensitive tool calls.
  // `taskId` references `tasks.taskId` (domain id), not `tasks._id`.
  //
  // Primary access patterns:
  // - Resolve by approval id.
  // - List approvals by workspace and status.
  approvals: defineTable({
    approvalId: v.string(), // domain ID: approval_<uuid>
    taskId: v.string(), // references tasks.taskId (not tasks._id)
    workspaceId: v.id("workspaces"),
    toolPath: v.string(),
    input: jsonObject,
    status: approvalStatus,
    reason: v.optional(v.string()),
    reviewerId: v.optional(v.string()), // account._id or anon_<uuid>
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_approval_id", ["approvalId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_status_created", ["workspaceId", "status", "createdAt"]),

  // Individual tool call rows emitted during a task.
  //
  // Primary access patterns:
  // - Get a specific call by (taskId, callId).
  // - List calls for a task ordered by creation time.
  toolCalls: defineTable({
    taskId: v.string(),
    callId: v.string(),
    workspaceId: v.id("workspaces"),
    toolPath: v.string(),
    status: toolCallStatus,
    approvalId: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_task_call", ["taskId", "callId"])
    .index("by_task_created", ["taskId", "createdAt"])
    .index("by_workspace_created", ["workspaceId", "createdAt"]),

  // Append-only event log for a task.
  // `sequence` is monotonically increasing per task (used for ordered replay).
  taskEvents: defineTable({
    sequence: v.number(),
    taskId: v.string(), // references tasks.taskId (not tasks._id)
    eventName: v.string(),
    type: v.string(),
    payload: jsonObject,
    createdAt: v.number(),
  })
    .index("by_task_sequence", ["taskId", "sequence"]),

  // Named tool roles (permission bundles) scoped to an organization.
  toolRoles: defineTable({
    roleId: v.string(), // domain ID: trole_<uuid>
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    createdByAccountId: v.optional(v.id("accounts")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_role_id", ["roleId"])
    .index("by_org_name", ["organizationId", "name"])
    .index("by_org_created", ["organizationId", "createdAt"]),

  // Rules belonging to a tool role.
  toolRoleRules: defineTable({
    ruleId: v.string(), // domain ID: trule_<uuid>
    roleId: v.string(),
    organizationId: v.id("organizations"),
    selectorType: toolRoleSelectorType,
    sourceKey: v.optional(v.string()),
    namespacePattern: v.optional(v.string()),
    toolPathPattern: v.optional(v.string()),
    matchType: policyMatchType,
    effect: policyEffect,
    approvalMode: policyApprovalMode,
    argumentConditions: v.optional(v.array(v.object({
      key: v.string(),
      operator: v.union(v.literal("equals"), v.literal("contains"), v.literal("starts_with"), v.literal("not_equals")),
      value: v.string(),
    }))),
    priority: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_rule_id", ["ruleId"])
    .index("by_role_created", ["roleId", "createdAt"])
    .index("by_org_created", ["organizationId", "createdAt"]),

  // Role assignments to org/workspace/account/client contexts.
  toolRoleBindings: defineTable({
    bindingId: v.string(), // domain ID: trbind_<uuid>
    roleId: v.string(),
    organizationId: v.id("organizations"),
    scopeType: policyScopeType,
    workspaceId: v.optional(v.id("workspaces")),
    targetAccountId: v.optional(v.id("accounts")),
    clientId: v.optional(v.string()),
    status: toolRoleBindingStatus,
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_binding_id", ["bindingId"])
    .index("by_role_created", ["roleId", "createdAt"])
    .index("by_org_created", ["organizationId", "createdAt"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_org_target_account_created", ["organizationId", "targetAccountId", "createdAt"]),

  // Stored credentials for tool sources.
  //
  // A single credential "connection" (credentialId) can have multiple rows to support
  // different bindings (workspace-wide and per-account), and can be owned by either a
  // workspace or an organization.
  // `bindingId` exists as a stable handle
  // for UI/API operations that need an id before the connection id is known.
  //
  // Primary access patterns:
  // - Resolve by (workspaceId|organizationId, sourceKey, scopeKey).
  // - List effective credentials for a workspace by createdAt.
  sourceCredentials: defineTable({
    bindingId: v.string(), // domain ID: bind_<uuid>
    credentialId: v.string(), // domain ID: conn_<uuid>
    scopeType: credentialScopeType,
    accountId: v.optional(v.id("accounts")),
    organizationId: v.id("organizations"),
    workspaceId: v.optional(v.id("workspaces")),
    sourceKey: v.string(),
    provider: credentialProvider,
    secretJson: jsonObject,
    overridesJson: v.optional(jsonObject),
    boundAuthFingerprint: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_organization_created", ["organizationId", "createdAt"])
    .index("by_org_account_created", ["organizationId", "accountId", "createdAt"])
    .index("by_workspace_source_scope", ["workspaceId", "sourceKey", "scopeType"])
    .index("by_organization_source_scope", ["organizationId", "sourceKey", "scopeType"])
    .index("by_org_account_source_scope", ["organizationId", "accountId", "sourceKey", "scopeType"])
    .index("by_workspace_credential", ["workspaceId", "credentialId"])
    .index("by_organization_credential", ["organizationId", "credentialId"])
    .index("by_org_account_credential", ["organizationId", "accountId", "credentialId"])
    .index("by_source", ["sourceKey"])
    .index("by_binding_id", ["bindingId"]),

  // Configured tool sources for a workspace/organization (MCP servers, OpenAPI sources, GraphQL sources).
  // `specHash` enables cache invalidation when the definition changes.
  // `authFingerprint` is used to determine whether cached tool materialization is still valid.
  //
  // Primary access patterns:
  // - Resolve by domain source id.
  // - List effective sources by workspace, sorted by updatedAt.
  // - Enforce name uniqueness per owner scope.
  toolSources: defineTable({
    sourceId: v.string(), // domain ID: src_<uuid>
    scopeType: toolSourceScopeType,
    organizationId: v.id("organizations"),
    workspaceId: v.optional(v.id("workspaces")),
    name: v.string(),
    type: toolSourceType,
    config: jsonObject,
    specHash: v.optional(v.string()),
    authFingerprint: v.optional(v.string()),
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source_id", ["sourceId"])
    .index("by_workspace_updated", ["workspaceId", "updatedAt"])
    .index("by_organization_updated", ["organizationId", "updatedAt"])
    .index("by_organization_scope_updated", ["organizationId", "scopeType", "updatedAt"])
    .index("by_workspace_name", ["workspaceId", "name"])
    .index("by_organization_name", ["organizationId", "name"])
    .index("by_organization_scope_name", ["organizationId", "scopeType", "name"]),

  // Cached OpenAPI spec blobs stored in Convex storage.
  // (specUrl, version) uniquely identifies a stored spec payload.
  openApiSpecCache: defineTable({
    specUrl: v.string(),
    storageId: v.id("_storage"),
    version: v.string(),
    sizeBytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_spec_url_version", ["specUrl", "version"]),

  // Workspace tool registry state.
  // Stores the currently "ready" build id for search + invocation.
  workspaceToolRegistryState: defineTable({
    workspaceId: v.id("workspaces"),
    signature: v.optional(v.string()),
    readyBuildId: v.optional(v.string()),
    buildingBuildId: v.optional(v.string()),
    buildingSignature: v.optional(v.string()),
    buildingStartedAt: v.optional(v.number()),
    lastBuildCompletedAt: v.optional(v.number()),
    lastBuildFailedAt: v.optional(v.number()),
    lastBuildError: v.optional(v.string()),
    typesStorageId: v.optional(v.id("_storage")),
    warnings: v.optional(v.array(v.string())),
    toolCount: v.optional(v.number()),
    sourceToolCounts: v.optional(v.array(v.object({
      sourceName: v.string(),
      toolCount: v.number(),
    }))),
    sourceVersions: v.optional(v.array(v.object({
      sourceId: v.string(),
      sourceName: v.string(),
      updatedAt: v.number(),
    }))),
    sourceQuality: v.optional(v.array(v.object({
      sourceKey: v.string(),
      toolCount: v.number(),
      unknownArgsCount: v.number(),
      unknownReturnsCount: v.number(),
      partialUnknownArgsCount: v.number(),
      partialUnknownReturnsCount: v.number(),
      argsQuality: v.number(),
      returnsQuality: v.number(),
      overallQuality: v.number(),
    }))),
    sourceAuthProfiles: v.optional(v.array(v.object({
      sourceKey: v.string(),
      type: v.union(v.literal("none"), v.literal("bearer"), v.literal("apiKey"), v.literal("basic"), v.literal("mixed")),
      mode: v.optional(v.union(v.literal("account"), v.literal("organization"), v.literal("workspace"))),
      header: v.optional(v.string()),
      inferred: v.boolean(),
    }))),
    openApiRefHintTables: v.optional(v.array(v.object({
      sourceKey: v.string(),
      refs: v.array(v.object({
        key: v.string(),
        hint: v.string(),
      })),
    }))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"]),

  // Per-tool registry entries for fast discover + invocation.
  // NOTE: We avoid storing raw JSON Schemas here because Convex forbids `$`-prefixed keys.
  workspaceToolRegistry: defineTable({
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    path: v.string(),
    preferredPath: v.string(),
    namespace: v.string(),
    normalizedPath: v.string(),
    aliases: v.array(v.string()),
    description: v.string(),
    approval: toolApprovalMode,
    source: v.optional(v.string()),
    searchText: v.string(),
    displayInput: v.optional(v.string()),
    displayOutput: v.optional(v.string()),
    requiredInputKeys: v.optional(v.array(v.string())),
    previewInputKeys: v.optional(v.array(v.string())),
    typedRef: v.optional(v.object({
      kind: v.literal("openapi_operation"),
      sourceKey: v.string(),
      operationId: v.string(),
    })),
    createdAt: v.number(),
  })
    .index("by_workspace_build_path", ["workspaceId", "buildId", "path"])
    .index("by_workspace_build_normalized", ["workspaceId", "buildId", "normalizedPath"])
    .index("by_workspace_build_source", ["workspaceId", "buildId", "source"])
    .index("by_workspace_build_namespace", ["workspaceId", "buildId", "namespace"])
    .index("by_workspace_build", ["workspaceId", "buildId"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["workspaceId", "buildId"],
    }),

  // Heavy per-tool payloads kept separate from searchable metadata.
  workspaceToolRegistryPayloads: defineTable({
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    path: v.string(),
    serializedToolJson: v.string(),
    createdAt: v.number(),
  })
    .index("by_workspace_build_path", ["workspaceId", "buildId", "path"])
    .index("by_workspace_build", ["workspaceId", "buildId"]),

  // Precomputed namespace summaries for fast catalog.namespaces.
  workspaceToolNamespaces: defineTable({
    workspaceId: v.id("workspaces"),
    buildId: v.string(),
    namespace: v.string(),
    toolCount: v.number(),
    samplePaths: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_workspace_build", ["workspaceId", "buildId"]),

  // Anonymous session linkage.
  // Used to map an unauthenticated/anonymous account to a backing `accounts` row and a
  // workspace.
  //
  // Primary access patterns:
  // - Resolve by session id.
  // - Resolve by (workspaceId, accountId) to find an existing session.
  // - List sessions for an account.
  anonymousSessions: defineTable({
    sessionId: v.string(), // domain ID: anon_session_<uuid> or mcp_<uuid>
    workspaceId: v.id("workspaces"),
    clientId: v.string(), // client label: "web", "mcp", etc.
    accountId: v.id("accounts"),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_workspace_account", ["workspaceId", "accountId"])
    .index("by_account", ["accountId"]),
});
