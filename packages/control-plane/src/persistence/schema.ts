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
  organizations: "organizations",
  organizationMemberships: "organization_memberships",
  workspaces: "workspaces",
  sources: "sources",
  policies: "policies",
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
    uniqueIndex("sources_workspace_name_idx").on(table.workspaceId, table.name),
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

export const drizzleSchema = {
  organizationsTable,
  organizationMembershipsTable,
  workspacesTable,
  sourcesTable,
  policiesTable,
};

export type DrizzleTables = typeof drizzleSchema;
