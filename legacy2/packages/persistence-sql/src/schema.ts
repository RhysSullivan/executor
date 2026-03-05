import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const tableNames = {
  profile: "profile",
  organizations: "organizations",
  organizationMemberships: "organization_memberships",
  workspaces: "workspaces",
  sources: "sources",
  toolManifests: "tool_manifests",
  toolArtifacts: "tool_artifacts",
  authConnections: "auth_connections",
  sourceAuthBindings: "source_auth_bindings",
  authMaterials: "auth_materials",
  oauthStates: "oauth_states",
  secretMaterials: "secret_materials",
  policies: "policies",
  interactions: "interactions",
  taskRuns: "task_runs",
  storageInstances: "storage_instances",
  syncStates: "sync_states",
} as const;

export const organizationsTable = pgTable(tableNames.organizations, {
  id: text("id").notNull().primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  createdByAccountId: text("created_by_account_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  uniqueIndex("organizations_slug_idx").on(table.slug),
  index("organizations_updated_idx").on(table.updatedAt, table.id),
  check(
    "organizations_status_check",
    sql`${table.status} in ('active', 'suspended', 'archived')`,
  ),
]);

export const workspacesTable = pgTable(
  tableNames.workspaces,
  {
    id: text("id").notNull().primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    createdByAccountId: text("created_by_account_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("workspaces_org_idx").on(table.organizationId),
    index("workspaces_org_updated_idx").on(
      table.organizationId,
      table.updatedAt,
      table.id,
    ),
    uniqueIndex("workspaces_org_name_idx").on(table.organizationId, table.name),
  ],
);

export const organizationMembershipsTable = pgTable(
  tableNames.organizationMemberships,
  {
    id: text("id").notNull().primaryKey(),
    organizationId: text("organization_id").notNull(),
    accountId: text("account_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    billable: boolean("billable").notNull(),
    invitedByAccountId: text("invited_by_account_id"),
    joinedAt: bigint("joined_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("organization_memberships_org_idx").on(table.organizationId),
    index("organization_memberships_account_idx").on(table.accountId),
    index("organization_memberships_org_updated_idx").on(
      table.organizationId,
      table.updatedAt,
      table.id,
    ),
    index("organization_memberships_account_updated_idx").on(
      table.accountId,
      table.updatedAt,
      table.id,
    ),
    uniqueIndex("organization_memberships_org_account_idx").on(
      table.organizationId,
      table.accountId,
    ),
    check(
      "organization_memberships_role_check",
      sql`${table.role} in ('viewer', 'editor', 'admin', 'owner')`,
    ),
    check(
      "organization_memberships_status_check",
      sql`${table.status} in ('invited', 'active', 'suspended', 'removed')`,
    ),
  ],
);

export const profileTable = pgTable(tableNames.profile, {
  id: text("id").notNull().primaryKey(),
  defaultWorkspaceId: text("default_workspace_id"),
  displayName: text("display_name").notNull(),
  runtimeMode: text("runtime_mode").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  index("profile_updated_idx").on(table.updatedAt, table.id),
  check(
    "profile_runtime_mode_check",
    sql`${table.runtimeMode} in ('local', 'linked', 'remote')`,
  ),
]);

export const sourcesTable = pgTable(
  tableNames.sources,
  {
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status").notNull(),
    enabled: boolean("enabled").notNull(),
    configJson: text("config_json").notNull(),
    sourceHash: text("source_hash"),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sourceId],
    }),
    uniqueIndex("sources_source_id_idx").on(table.sourceId),
    uniqueIndex("sources_workspace_name_idx").on(table.workspaceId, table.name),
    index("sources_workspace_name_source_idx").on(
      table.workspaceId,
      table.name,
      table.sourceId,
    ),
    check(
      "sources_kind_check",
      sql`${table.kind} in ('mcp', 'openapi', 'graphql', 'internal')`,
    ),
    check(
      "sources_status_check",
      sql`${table.status} in ('draft', 'probing', 'auth_required', 'connected', 'error')`,
    ),
  ],
);

export const toolManifestsTable = pgTable(
  tableNames.toolManifests,
  {
    sourceHash: text("source_hash").notNull().primaryKey(),
    toolCount: bigint("tool_count", { mode: "number" }).notNull(),
    manifestJson: text("manifest_json").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    check("tool_manifests_tool_count_nonnegative", sql`${table.toolCount} >= 0`),
  ],
);

export const toolArtifactsTable = pgTable(
  tableNames.toolArtifacts,
  {
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sourceId],
    }),
    uniqueIndex("tool_artifacts_id_idx").on(table.id),
    index("tool_artifacts_source_hash_idx").on(table.sourceHash),
  ],
);

export const authConnectionsTable = pgTable(
  tableNames.authConnections,
  {
    id: text("id").notNull().primaryKey(),
    organizationId: text("organization_id").notNull(),
    workspaceId: text("workspace_id"),
    accountId: text("account_id"),
    ownerType: text("owner_type").notNull(),
    strategy: text("strategy").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull(),
    statusReason: text("status_reason"),
    lastAuthErrorClass: text("last_auth_error_class"),
    metadataJson: text("metadata_json"),
    additionalHeadersJson: text("additional_headers_json"),
    createdByAccountId: text("created_by_account_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    lastUsedAt: bigint("last_used_at", { mode: "number" }),
  },
  (table) => [
    index("auth_connections_org_idx").on(table.organizationId),
    index("auth_connections_workspace_idx").on(table.workspaceId),
    index("auth_connections_account_idx").on(table.accountId),
    index("auth_connections_org_updated_idx").on(
      table.organizationId,
      table.updatedAt,
      table.id,
    ),
    check(
      "auth_connections_owner_type_check",
      sql`${table.ownerType} in ('organization', 'workspace', 'account')`,
    ),
    check(
      "auth_connections_strategy_check",
      sql`${table.strategy} in ('oauth2', 'api_key', 'bearer', 'basic', 'custom')`,
    ),
    check(
      "auth_connections_status_check",
      sql`${table.status} in ('active', 'reauth_required', 'revoked', 'disabled', 'error')`,
    ),
    check(
      "auth_connections_owner_scope_check",
      sql`(
        (${table.ownerType} = 'organization' AND ${table.workspaceId} IS NULL AND ${table.accountId} IS NULL)
        OR (${table.ownerType} = 'workspace' AND ${table.workspaceId} IS NOT NULL AND ${table.accountId} IS NULL)
        OR (${table.ownerType} = 'account' AND ${table.workspaceId} IS NULL AND ${table.accountId} IS NOT NULL)
      )`,
    ),
  ],
);

export const sourceAuthBindingsTable = pgTable(
  tableNames.sourceAuthBindings,
  {
    id: text("id").notNull().primaryKey(),
    sourceId: text("source_id").notNull(),
    connectionId: text("connection_id").notNull(),
    organizationId: text("organization_id").notNull(),
    workspaceId: text("workspace_id"),
    accountId: text("account_id"),
    scopeType: text("scope_type").notNull(),
    selector: text("selector"),
    enabled: boolean("enabled").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("source_auth_bindings_source_idx").on(table.sourceId),
    index("source_auth_bindings_connection_idx").on(
      table.connectionId,
      table.updatedAt,
      table.id,
    ),
    index("source_auth_bindings_org_idx").on(table.organizationId),
    index("source_auth_bindings_workspace_idx").on(table.workspaceId),
    index("source_auth_bindings_account_idx").on(table.accountId),
    index("source_auth_bindings_workspace_scope_idx")
      .on(table.workspaceId, table.updatedAt, table.createdAt)
      .where(sql`${table.workspaceId} is not null`),
    index("source_auth_bindings_org_scope_idx")
      .on(table.organizationId, table.updatedAt, table.createdAt)
      .where(sql`${table.workspaceId} is null`),
    check(
      "source_auth_bindings_scope_type_check",
      sql`${table.scopeType} in ('workspace', 'organization', 'account')`,
    ),
    check(
      "source_auth_bindings_scope_shape_check",
      sql`(
        (${table.scopeType} = 'organization' AND ${table.workspaceId} IS NULL AND ${table.accountId} IS NULL)
        OR (${table.scopeType} = 'workspace' AND ${table.workspaceId} IS NOT NULL AND ${table.accountId} IS NULL)
        OR (${table.scopeType} = 'account' AND ${table.workspaceId} IS NULL AND ${table.accountId} IS NOT NULL)
      )`,
    ),
  ],
);

export const authMaterialsTable = pgTable(
  tableNames.authMaterials,
  {
    id: text("id").notNull().primaryKey(),
    connectionId: text("connection_id").notNull(),
    backend: text("backend").notNull(),
    materialHandle: text("material_handle").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("auth_materials_connection_idx").on(table.connectionId),
    uniqueIndex("auth_materials_material_handle_idx").on(table.materialHandle),
  ],
);

export const oauthStatesTable = pgTable(
  tableNames.oauthStates,
  {
    id: text("id").notNull().primaryKey(),
    connectionId: text("connection_id").notNull(),
    backend: text("backend").notNull(),
    accessTokenHandle: text("access_token_handle").notNull(),
    refreshTokenHandle: text("refresh_token_handle"),
    clientSecretHandle: text("client_secret_handle"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    scope: text("scope"),
    tokenType: text("token_type"),
    issuer: text("issuer"),
    refreshConfigJson: text("refresh_config_json"),
    tokenVersion: bigint("token_version", { mode: "number" }).notNull(),
    leaseHolder: text("lease_holder"),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    leaseFence: bigint("lease_fence", { mode: "number" }).notNull(),
    lastRefreshAt: bigint("last_refresh_at", { mode: "number" }),
    lastRefreshErrorClass: text("last_refresh_error_class"),
    lastRefreshError: text("last_refresh_error"),
    reauthRequiredAt: bigint("reauth_required_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("oauth_states_connection_idx").on(table.connectionId),
    uniqueIndex("oauth_states_access_token_handle_idx").on(table.accessTokenHandle),
    check("oauth_states_token_version_nonnegative", sql`${table.tokenVersion} >= 0`),
    check("oauth_states_lease_fence_nonnegative", sql`${table.leaseFence} >= 0`),
  ],
);

export const secretMaterialsTable = pgTable(
  tableNames.secretMaterials,
  {
    handle: text("handle").notNull().primaryKey(),
    backend: text("backend").notNull(),
    organizationId: text("organization_id").notNull(),
    workspaceId: text("workspace_id"),
    accountId: text("account_id"),
    connectionId: text("connection_id").notNull(),
    purpose: text("purpose").notNull(),
    material: text("material").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("secret_materials_connection_idx").on(table.connectionId, table.updatedAt),
    index("secret_materials_org_idx").on(table.organizationId, table.updatedAt),
    check(
      "secret_materials_purpose_check",
      sql`${table.purpose} in ('auth_material', 'oauth_access_token', 'oauth_refresh_token', 'oauth_client_secret')`,
    ),
  ],
);

export const policiesTable = pgTable(
  tableNames.policies,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    toolPathPattern: text("tool_path_pattern").notNull(),
    decision: text("decision").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("policies_workspace_idx").on(table.workspaceId, table.updatedAt, table.id),
    uniqueIndex("policies_workspace_tool_path_idx").on(
      table.workspaceId,
      table.toolPathPattern,
    ),
    check(
      "policies_decision_check",
      sql`${table.decision} in ('allow', 'require_approval', 'deny')`,
    ),
  ],
);

export const taskRunsTable = pgTable(
  tableNames.taskRuns,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    accountId: text("account_id").notNull(),
    sessionId: text("session_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    codeHash: text("code_hash").notNull(),
    status: text("status").notNull(),
    startedAt: bigint("started_at", { mode: "number" }),
    completedAt: bigint("completed_at", { mode: "number" }),
    exitCode: bigint("exit_code", { mode: "number" }),
    error: text("error"),
  },
  (table) => [
    index("task_runs_workspace_idx").on(table.workspaceId),
    check(
      "task_runs_status_check",
      sql`${table.status} in ('queued', 'running', 'waiting_for_interaction', 'completed', 'failed', 'timed_out', 'denied')`,
    ),
  ],
);

export const interactionsTable = pgTable(
  tableNames.interactions,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    taskRunId: text("task_run_id").notNull(),
    originServer: text("origin_server").notNull(),
    originRequestId: text("origin_request_id").notNull(),
    callId: text("call_id").notNull(),
    toolPath: text("tool_path").notNull(),
    mode: text("mode").notNull(),
    elicitationId: text("elicitation_id"),
    message: text("message").notNull(),
    requestedSchemaJson: text("requested_schema_json"),
    url: text("url"),
    status: text("status").notNull(),
    requestJson: text("request_json").notNull(),
    responseAction: text("response_action"),
    responseContentJson: text("response_content_json"),
    reason: text("reason"),
    requestedAt: bigint("requested_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    completionNotifiedAt: bigint("completion_notified_at", { mode: "number" }),
    expiresAt: bigint("expires_at", { mode: "number" }),
  },
  (table) => [
    index("interactions_workspace_idx").on(table.workspaceId, table.requestedAt, table.id),
    index("interactions_task_run_idx").on(table.taskRunId),
    uniqueIndex("interactions_origin_request_idx").on(table.originServer, table.originRequestId),
    uniqueIndex("interactions_url_elicitation_idx")
      .on(table.originServer, table.elicitationId)
      .where(sql`${table.elicitationId} is not null`),
    index("interactions_lookup_idx").on(
      table.workspaceId,
      table.taskRunId,
      table.callId,
      table.requestedAt,
    ),
    check(
      "interactions_mode_check",
      sql`${table.mode} in ('form', 'url')`,
    ),
    check(
      "interactions_status_check",
      sql`${table.status} in ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'failed')`,
    ),
    check(
      "interactions_response_action_check",
      sql`${table.responseAction} is null or ${table.responseAction} in ('accept', 'decline', 'cancel')`,
    ),
  ],
);

export const storageInstancesTable = pgTable(
  tableNames.storageInstances,
  {
    id: text("id").notNull().primaryKey(),
    scopeType: text("scope_type").notNull(),
    durability: text("durability").notNull(),
    status: text("status").notNull(),
    provider: text("provider").notNull(),
    backendKey: text("backend_key").notNull(),
    organizationId: text("organization_id").notNull(),
    workspaceId: text("workspace_id"),
    accountId: text("account_id"),
    createdByAccountId: text("created_by_account_id"),
    purpose: text("purpose"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    fileCount: bigint("file_count", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    closedAt: bigint("closed_at", { mode: "number" }),
    expiresAt: bigint("expires_at", { mode: "number" }),
  },
  (table) => [
    index("storage_instances_org_idx").on(table.organizationId),
    index("storage_instances_workspace_idx").on(table.workspaceId),
    index("storage_instances_workspace_scope_idx")
      .on(table.workspaceId, table.updatedAt, table.id)
      .where(sql`${table.workspaceId} is not null`),
    index("storage_instances_org_scope_idx")
      .on(table.organizationId, table.updatedAt, table.id)
      .where(sql`${table.workspaceId} is null`),
    uniqueIndex("storage_instances_provider_backend_idx").on(
      table.provider,
      table.backendKey,
    ),
    check(
      "storage_instances_scope_type_check",
      sql`${table.scopeType} in ('scratch', 'account', 'workspace', 'organization')`,
    ),
    check(
      "storage_instances_durability_check",
      sql`${table.durability} in ('ephemeral', 'durable')`,
    ),
    check(
      "storage_instances_status_check",
      sql`${table.status} in ('active', 'closed', 'deleted')`,
    ),
    check(
      "storage_instances_provider_check",
      sql`${table.provider} in ('agentfs-local', 'agentfs-cloudflare')`,
    ),
    check(
      "storage_instances_size_nonnegative",
      sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`,
    ),
    check(
      "storage_instances_file_count_nonnegative",
      sql`${table.fileCount} is null or ${table.fileCount} >= 0`,
    ),
  ],
);

export const syncStatesTable = pgTable(
  tableNames.syncStates,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    target: text("target").notNull(),
    targetUrl: text("target_url").notNull(),
    linkedSubject: text("linked_subject"),
    cursor: text("cursor"),
    lastSyncAt: bigint("last_sync_at", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("sync_states_workspace_idx").on(table.workspaceId),
    uniqueIndex("sync_states_workspace_target_url_idx").on(
      table.workspaceId,
      table.target,
      table.targetUrl,
    ),
    check("sync_states_target_check", sql`${table.target} in ('remote')`),
  ],
);
