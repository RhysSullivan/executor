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
  accounts: "accounts",
  organizations: "organizations",
  organizationMemberships: "organization_memberships",
  workspaces: "workspaces",
  sources: "sources",
  sourceCredentialBindings: "source_credential_bindings",
  policies: "policies",
  localInstallations: "local_installations",
  executions: "executions",
  executionInteractions: "execution_interactions",
} as const;

export const accountsTable = pgTable(
  tableNames.accounts,
  {
    id: text("id").notNull().primaryKey(),
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("accounts_provider_subject_idx").on(table.provider, table.subject),
    index("accounts_updated_idx").on(table.updatedAt, table.id),
    check(
      "accounts_provider_check",
      sql`${table.provider} in ('local', 'workos', 'service')`,
    ),
  ],
);

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
    uniqueIndex("workspaces_org_name_idx").on(table.organizationId, table.name),
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
    namespace: text("namespace"),
    transport: text("transport"),
    queryParamsJson: text("query_params_json"),
    headersJson: text("headers_json"),
    specUrl: text("spec_url"),
    defaultHeadersJson: text("default_headers_json"),
    authKind: text("auth_kind").notNull(),
    authHeaderName: text("auth_header_name"),
    authPrefix: text("auth_prefix"),
    sourceHash: text("source_hash"),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sourceId],
    }),
    uniqueIndex("sources_workspace_name_idx").on(table.workspaceId, table.name),
    check(
      "sources_kind_check",
      sql`${table.kind} in ('mcp', 'openapi', 'graphql', 'internal')`,
    ),
    check(
      "sources_status_check",
      sql`${table.status} in ('draft', 'probing', 'auth_required', 'connected', 'error')`,
    ),
    check(
      "sources_transport_check",
      sql`${table.transport} is null or ${table.transport} in ('auto', 'streamable-http', 'sse')`,
    ),
    check(
      "sources_auth_kind_check",
      sql`${table.authKind} in ('none', 'bearer', 'oauth2')`,
    ),
  ],
);

export const sourceCredentialBindingsTable = pgTable(
  tableNames.sourceCredentialBindings,
  {
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    tokenProviderId: text("token_provider_id"),
    tokenHandle: text("token_handle"),
    refreshTokenProviderId: text("refresh_token_provider_id"),
    refreshTokenHandle: text("refresh_token_handle"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sourceId],
    }),
    index("source_credential_bindings_workspace_idx").on(
      table.workspaceId,
      table.updatedAt,
      table.sourceId,
    ),
  ],
);

export const policiesTable = pgTable(
  tableNames.policies,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    targetAccountId: text("target_account_id"),
    clientId: text("client_id"),
    resourceType: text("resource_type").notNull(),
    resourcePattern: text("resource_pattern").notNull(),
    matchType: text("match_type").notNull(),
    effect: text("effect").notNull(),
    approvalMode: text("approval_mode").notNull(),
    argumentConditionsJson: text("argument_conditions_json"),
    priority: bigint("priority", { mode: "number" }).notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("policies_workspace_idx").on(table.workspaceId, table.updatedAt, table.id),
    check(
      "policies_resource_type_check",
      sql`${table.resourceType} in ('all_tools', 'source', 'namespace', 'tool_path')`,
    ),
    check(
      "policies_match_type_check",
      sql`${table.matchType} in ('glob', 'exact')`,
    ),
    check(
      "policies_effect_check",
      sql`${table.effect} in ('allow', 'deny')`,
    ),
    check(
      "policies_approval_mode_check",
      sql`${table.approvalMode} in ('auto', 'required')`,
    ),
  ],
);

export const localInstallationsTable = pgTable(tableNames.localInstallations, {
  id: text("id").notNull().primaryKey(),
  accountId: text("account_id").notNull(),
  organizationId: text("organization_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const executionsTable = pgTable(
  tableNames.executions,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    createdByAccountId: text("created_by_account_id").notNull(),
    status: text("status").notNull(),
    code: text("code").notNull(),
    resultJson: text("result_json"),
    errorText: text("error_text"),
    logsJson: text("logs_json"),
    startedAt: bigint("started_at", { mode: "number" }),
    completedAt: bigint("completed_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("executions_workspace_idx").on(table.workspaceId, table.updatedAt, table.id),
    check(
      "executions_status_check",
      sql`${table.status} in ('pending', 'running', 'waiting_for_interaction', 'completed', 'failed', 'cancelled')`,
    ),
  ],
);

export const executionInteractionsTable = pgTable(
  tableNames.executionInteractions,
  {
    id: text("id").notNull().primaryKey(),
    executionId: text("execution_id").notNull(),
    status: text("status").notNull(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    responseJson: text("response_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("execution_interactions_execution_idx").on(
      table.executionId,
      table.updatedAt,
      table.id,
    ),
    check(
      "execution_interactions_status_check",
      sql`${table.status} in ('pending', 'resolved', 'cancelled')`,
    ),
  ],
);

export const drizzleSchema = {
  accountsTable,
  organizationsTable,
  organizationMembershipsTable,
  workspacesTable,
  sourcesTable,
  sourceCredentialBindingsTable,
  policiesTable,
  localInstallationsTable,
  executionsTable,
  executionInteractionsTable,
};

export type DrizzleTables = typeof drizzleSchema;
