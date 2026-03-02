import {
  bigint,
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { tableNames } from "./schema";

export const profileTable = pgTable(tableNames.profile, {
  id: text("id").notNull().primaryKey(),
  defaultWorkspaceId: text("default_workspace_id"),
  displayName: text("display_name").notNull(),
  runtimeMode: text("runtime_mode").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const organizationsTable = pgTable(tableNames.organizations, {
  id: text("id").notNull().primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  createdByAccountId: text("created_by_account_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

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
  ],
);

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
  ],
);

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
    index("sources_workspace_name_idx").on(table.workspaceId, table.name),
  ],
);

export const toolArtifactsTable = pgTable(
  tableNames.toolArtifacts,
  {
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    toolCount: bigint("tool_count", { mode: "number" }).notNull(),
    manifestJson: text("manifest_json").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sourceId],
    }),
    uniqueIndex("tool_artifacts_id_idx").on(table.id),
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
    index("source_auth_bindings_connection_idx").on(table.connectionId),
    index("source_auth_bindings_org_idx").on(table.organizationId),
    index("source_auth_bindings_workspace_idx").on(table.workspaceId),
    index("source_auth_bindings_account_idx").on(table.accountId),
  ],
);

export const authMaterialsTable = pgTable(
  tableNames.authMaterials,
  {
    id: text("id").notNull().primaryKey(),
    connectionId: text("connection_id").notNull(),
    ciphertext: text("ciphertext").notNull(),
    keyVersion: text("key_version").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("auth_materials_connection_idx").on(table.connectionId),
  ],
);

export const oauthStatesTable = pgTable(
  tableNames.oauthStates,
  {
    id: text("id").notNull().primaryKey(),
    connectionId: text("connection_id").notNull(),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    keyVersion: text("key_version").notNull(),
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
    index("oauth_states_connection_idx").on(table.connectionId),
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
    index("policies_workspace_idx").on(table.workspaceId),
  ],
);

export const approvalsTable = pgTable(
  tableNames.approvals,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    taskRunId: text("task_run_id").notNull(),
    callId: text("call_id").notNull(),
    toolPath: text("tool_path").notNull(),
    status: text("status").notNull(),
    inputPreviewJson: text("input_preview_json").notNull(),
    reason: text("reason"),
    requestedAt: bigint("requested_at", { mode: "number" }).notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
  },
  (table) => [
    index("approvals_workspace_idx").on(table.workspaceId),
    index("approvals_task_run_idx").on(table.taskRunId),
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
  ],
);
