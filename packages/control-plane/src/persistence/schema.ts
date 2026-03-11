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
  sourceRecipes: "source_recipes",
  sourceRecipeRevisions: "source_recipe_revisions",
  sourceRecipeDocuments: "source_recipe_documents",
  sourceRecipeSchemaBundles: "source_recipe_schema_bundles",
  sourceRecipeOperations: "source_recipe_operations",
  codeMigrations: "control_plane_code_migrations",
  credentials: "workspace_source_credentials",
  workspaceSourceOauthClients: "workspace_source_oauth_clients",
  secretMaterials: "secret_materials",
  sourceAuthSessions: "source_auth_sessions",
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
    index("workspaces_org_updated_idx").on(
      table.organizationId,
      table.updatedAt,
      table.id,
    ),
    uniqueIndex("workspaces_org_name_idx").on(table.organizationId, table.name),
  ],
);

export const sourcesTable = pgTable(
  tableNames.sources,
  {
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    recipeId: text("recipe_id").notNull(),
    recipeRevisionId: text("recipe_revision_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status").notNull(),
    enabled: boolean("enabled").notNull(),
    namespace: text("namespace"),
    importAuthPolicy: text("import_auth_policy").notNull(),
    bindingConfigJson: text("binding_config_json").notNull(),
    sourceHash: text("source_hash"),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sourceId],
    }),
    index("sources_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
      table.sourceId,
    ),
    index("sources_workspace_recipe_idx").on(
      table.workspaceId,
      table.recipeId,
      table.updatedAt,
      table.sourceId,
    ),
    uniqueIndex("sources_workspace_name_idx").on(table.workspaceId, table.name),
    check(
      "sources_status_check",
      sql`${table.status} in ('draft', 'probing', 'auth_required', 'connected', 'error')`,
    ),
    check(
      "sources_import_auth_policy_check",
      sql`${table.importAuthPolicy} in ('none', 'reuse_runtime', 'separate')`,
    ),
  ],
);

export const sourceRecipesTable = pgTable(
  tableNames.sourceRecipes,
  {
    id: text("id").notNull().primaryKey(),
    kind: text("kind").notNull(),
    adapterKey: text("adapter_key").notNull(),
    providerKey: text("provider_key").notNull(),
    name: text("name").notNull(),
    summary: text("summary"),
    visibility: text("visibility").notNull(),
    latestRevisionId: text("latest_revision_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("source_recipes_provider_updated_idx").on(
      table.providerKey,
      table.updatedAt,
      table.id,
    ),
    index("source_recipes_visibility_updated_idx").on(
      table.visibility,
      table.updatedAt,
      table.id,
    ),
    check(
      "source_recipes_kind_check",
      sql`${table.kind} in ('http_api', 'mcp', 'internal')`,
    ),
    check(
      "source_recipes_visibility_check",
      sql`${table.visibility} in ('private', 'workspace', 'organization', 'public')`,
    ),
  ],
);

export const sourceRecipeRevisionsTable = pgTable(
  tableNames.sourceRecipeRevisions,
  {
    id: text("id").notNull().primaryKey(),
    recipeId: text("recipe_id").notNull(),
    revisionNumber: bigint("revision_number", { mode: "number" }).notNull(),
    sourceConfigJson: text("source_config_json").notNull(),
    manifestJson: text("manifest_json"),
    manifestHash: text("manifest_hash"),
    materializationHash: text("materialization_hash"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("source_recipe_revisions_recipe_revision_idx").on(
      table.recipeId,
      table.revisionNumber,
    ),
    uniqueIndex("source_recipe_revisions_recipe_materialization_idx").on(
      table.recipeId,
      table.materializationHash,
    ),
    index("source_recipe_revisions_recipe_manifest_idx").on(
      table.recipeId,
      table.manifestHash,
    ),
    index("source_recipe_revisions_recipe_created_idx").on(
      table.recipeId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const sourceRecipeDocumentsTable = pgTable(
  tableNames.sourceRecipeDocuments,
  {
    id: text("id").notNull().primaryKey(),
    recipeRevisionId: text("recipe_revision_id").notNull(),
    documentKind: text("document_kind").notNull(),
    documentKey: text("document_key").notNull(),
    contentText: text("content_text").notNull(),
    contentHash: text("content_hash").notNull(),
    fetchedAt: bigint("fetched_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("source_recipe_documents_revision_kind_key_idx").on(
      table.recipeRevisionId,
      table.documentKind,
      table.documentKey,
    ),
    index("source_recipe_documents_revision_created_idx").on(
      table.recipeRevisionId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const sourceRecipeSchemaBundlesTable = pgTable(
  tableNames.sourceRecipeSchemaBundles,
  {
    id: text("id").notNull().primaryKey(),
    recipeRevisionId: text("recipe_revision_id").notNull(),
    bundleKind: text("bundle_kind").notNull(),
    refsJson: text("refs_json").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("source_recipe_schema_bundles_revision_kind_idx").on(
      table.recipeRevisionId,
      table.bundleKind,
    ),
    index("source_recipe_schema_bundles_revision_created_idx").on(
      table.recipeRevisionId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const sourceRecipeOperationsTable = pgTable(
  tableNames.sourceRecipeOperations,
  {
    id: text("id").notNull().primaryKey(),
    recipeRevisionId: text("recipe_revision_id").notNull(),
    operationKey: text("operation_key").notNull(),
    transportKind: text("transport_kind").notNull(),
    toolId: text("tool_id").notNull(),
    title: text("title"),
    description: text("description"),
    operationKind: text("operation_kind").notNull(),
    searchText: text("search_text").notNull(),
    inputSchemaJson: text("input_schema_json"),
    outputSchemaJson: text("output_schema_json"),
    providerKind: text("provider_kind").notNull(),
    providerDataJson: text("provider_data_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("source_recipe_operations_revision_operation_key_idx").on(
      table.recipeRevisionId,
      table.operationKey,
    ),
    index("source_recipe_operations_revision_tool_idx").on(
      table.recipeRevisionId,
      table.toolId,
      table.updatedAt,
      table.id,
    ),
    index("source_recipe_operations_search_text_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.searchText})`,
    ),
    check(
      "source_recipe_operations_transport_kind_check",
      sql`${table.transportKind} in ('http', 'graphql', 'mcp', 'internal')`,
    ),
    check(
      "source_recipe_operations_kind_check",
      sql`${table.operationKind} in ('read', 'write', 'delete', 'unknown')`,
    ),
  ],
);

export const codeMigrationsTable = pgTable(
  tableNames.codeMigrations,
  {
    id: text("id").notNull().primaryKey(),
    appliedAt: bigint("applied_at", { mode: "number" }).notNull(),
  },
);

export const credentialsTable = pgTable(
  tableNames.credentials,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    actorAccountId: text("actor_account_id"),
    slot: text("slot").notNull(),
    authKind: text("auth_kind").notNull(),
    authHeaderName: text("auth_header_name").notNull(),
    authPrefix: text("auth_prefix").notNull(),
    tokenProviderId: text("token_provider_id").notNull(),
    tokenHandle: text("token_handle").notNull(),
    refreshTokenProviderId: text("refresh_token_provider_id"),
    refreshTokenHandle: text("refresh_token_handle"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("credentials_workspace_idx").on(
      table.workspaceId,
      table.updatedAt,
      table.id,
    ),
    uniqueIndex("credentials_workspace_source_actor_idx").on(
      table.workspaceId,
      table.sourceId,
      table.actorAccountId,
      table.slot,
    ),
    index("credentials_workspace_source_idx").on(
      table.workspaceId,
      table.sourceId,
      table.updatedAt,
      table.id,
    ),
    check(
      "credentials_auth_kind_check",
      sql`${table.authKind} in ('bearer', 'oauth2')`,
    ),
    check(
      "credentials_slot_check",
      sql`${table.slot} in ('runtime', 'import')`,
    ),
  ],
);

export const workspaceSourceOauthClientsTable = pgTable(
  tableNames.workspaceSourceOauthClients,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    providerKey: text("provider_key").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretProviderId: text("client_secret_provider_id"),
    clientSecretHandle: text("client_secret_handle"),
    clientMetadataJson: text("client_metadata_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("workspace_source_oauth_clients_workspace_source_provider_idx").on(
      table.workspaceId,
      table.sourceId,
      table.providerKey,
    ),
    index("workspace_source_oauth_clients_workspace_idx").on(
      table.workspaceId,
      table.updatedAt,
      table.sourceId,
    ),
  ],
);

export const secretMaterialsTable = pgTable(
  tableNames.secretMaterials,
  {
    id: text("id").notNull().primaryKey(),
    name: text("name"),
    purpose: text("purpose").notNull(),
    value: text("value").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("secret_materials_updated_idx").on(table.updatedAt, table.id),
    check(
      "secret_materials_purpose_check",
      sql`${table.purpose} in ('auth_material', 'oauth_access_token', 'oauth_refresh_token', 'oauth_client_info')`,
    ),
  ],
);

export const sourceAuthSessionsTable = pgTable(
  tableNames.sourceAuthSessions,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    actorAccountId: text("actor_account_id"),
    credentialSlot: text("credential_slot").notNull(),
    executionId: text("execution_id"),
    interactionId: text("interaction_id"),
    providerKind: text("provider_kind").notNull(),
    status: text("status").notNull(),
    state: text("state").notNull(),
    sessionDataJson: text("session_data_json").notNull(),
    errorText: text("error_text"),
    completedAt: bigint("completed_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("source_auth_sessions_workspace_idx").on(
      table.workspaceId,
      table.updatedAt,
      table.id,
    ),
    index("source_auth_sessions_pending_idx").on(
      table.workspaceId,
      table.sourceId,
      table.actorAccountId,
      table.credentialSlot,
      table.status,
      table.updatedAt,
      table.id,
    ),
    uniqueIndex("source_auth_sessions_state_idx").on(table.state),
    check(
      "source_auth_sessions_provider_kind_check",
      sql`${table.providerKind} in ('mcp_oauth', 'oauth2_pkce')`,
    ),
    check(
      "source_auth_sessions_status_check",
      sql`${table.status} in ('pending', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "source_auth_sessions_credential_slot_check",
      sql`${table.credentialSlot} in ('runtime', 'import')`,
    ),
  ],
);

export const policiesTable = pgTable(
  tableNames.policies,
  {
    id: text("id").notNull().primaryKey(),
    scopeType: text("scope_type").notNull(),
    organizationId: text("organization_id").notNull(),
    workspaceId: text("workspace_id"),
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
    index("policies_organization_priority_idx").on(
      table.organizationId,
      table.priority.desc(),
      table.updatedAt,
      table.id,
    ),
    index("policies_workspace_priority_idx").on(
      table.workspaceId,
      table.priority.desc(),
      table.updatedAt,
      table.id,
    ),
    check(
      "policies_scope_type_check",
      sql`${table.scopeType} in ('organization', 'workspace')`,
    ),
    check(
      "policies_scope_consistency_check",
      sql`(
        ${table.scopeType} = 'organization' and ${table.workspaceId} is null
      ) or (
        ${table.scopeType} = 'workspace' and ${table.workspaceId} is not null
      )`,
    ),
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

export const localInstallationsTable = pgTable(
  tableNames.localInstallations,
  {
    id: text("id").notNull().primaryKey(),
    accountId: text("account_id").notNull(),
    organizationId: text("organization_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("local_installations_organization_idx").on(table.organizationId),
    index("local_installations_workspace_idx").on(table.workspaceId),
  ],
);

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
    purpose: text("purpose").notNull(),
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
  sourceRecipesTable,
  sourceRecipeRevisionsTable,
  sourceRecipeDocumentsTable,
  sourceRecipeSchemaBundlesTable,
  sourceRecipeOperationsTable,
  codeMigrationsTable,
  credentialsTable,
  workspaceSourceOauthClientsTable,
  secretMaterialsTable,
  sourceAuthSessionsTable,
  policiesTable,
  localInstallationsTable,
  executionsTable,
  executionInteractionsTable,
};

export type DrizzleTables = typeof drizzleSchema;
