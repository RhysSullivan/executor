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
  sources: "sources",
  sourceRecipes: "source_recipes",
  sourceRecipeRevisions: "source_recipe_revisions",
  sourceRecipeDocuments: "source_recipe_documents",
  sourceRecipeSchemaBundles: "source_recipe_schema_bundles",
  sourceRecipeOperations: "source_recipe_operations",
  codeMigrations: "control_plane_code_migrations",
  authArtifacts: "workspace_source_auth_artifacts",
  authLeases: "workspace_source_auth_leases",
  workspaceSourceOauthClients: "workspace_source_oauth_clients",
  secretMaterials: "secret_materials",
  sourceAuthSessions: "source_auth_sessions",
  executions: "executions",
  executionInteractions: "execution_interactions",
  executionSteps: "execution_steps",
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

export const authArtifactsTable = pgTable(
  tableNames.authArtifacts,
  {
    id: text("id").notNull().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    actorAccountId: text("actor_account_id"),
    slot: text("slot").notNull(),
    artifactKind: text("artifact_kind").notNull(),
    configJson: text("config_json").notNull(),
    grantSetJson: text("grant_set_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("auth_artifacts_workspace_idx").on(
      table.workspaceId,
      table.updatedAt,
      table.id,
    ),
    uniqueIndex("auth_artifacts_workspace_source_actor_idx").on(
      table.workspaceId,
      table.sourceId,
      table.actorAccountId,
      table.slot,
    ),
    index("auth_artifacts_workspace_source_idx").on(
      table.workspaceId,
      table.sourceId,
      table.updatedAt,
      table.id,
    ),
    check(
      "auth_artifacts_slot_check",
      sql`${table.slot} in ('runtime', 'import')`,
    ),
  ],
);

export const authLeasesTable = pgTable(
  tableNames.authLeases,
  {
    id: text("id").notNull().primaryKey(),
    authArtifactId: text("auth_artifact_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    actorAccountId: text("actor_account_id"),
    slot: text("slot").notNull(),
    placementsTemplateJson: text("placements_template_json").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    refreshAfter: bigint("refresh_after", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("auth_leases_auth_artifact_idx").on(table.authArtifactId),
    index("auth_leases_workspace_source_idx").on(
      table.workspaceId,
      table.sourceId,
      table.actorAccountId,
      table.slot,
      table.updatedAt,
      table.id,
    ),
    check(
      "auth_leases_slot_check",
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
    responsePrivateJson: text("response_private_json"),
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

export const executionStepsTable = pgTable(
  tableNames.executionSteps,
  {
    id: text("id").notNull().primaryKey(),
    executionId: text("execution_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    path: text("path").notNull(),
    argsJson: text("args_json").notNull(),
    resultJson: text("result_json"),
    errorText: text("error_text"),
    interactionId: text("interaction_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("execution_steps_execution_sequence_idx").on(
      table.executionId,
      table.sequence,
    ),
    index("execution_steps_execution_updated_idx").on(
      table.executionId,
      table.updatedAt,
      table.id,
    ),
    check(
      "execution_steps_kind_check",
      sql`${table.kind} in ('tool_call')`,
    ),
    check(
      "execution_steps_status_check",
      sql`${table.status} in ('pending', 'waiting', 'completed', 'failed')`,
    ),
  ],
);

export const drizzleSchema = {
  accountsTable,
  sourcesTable,
  sourceRecipesTable,
  sourceRecipeRevisionsTable,
  sourceRecipeDocumentsTable,
  sourceRecipeSchemaBundlesTable,
  sourceRecipeOperationsTable,
  codeMigrationsTable,
  authArtifactsTable,
  authLeasesTable,
  workspaceSourceOauthClientsTable,
  secretMaterialsTable,
  sourceAuthSessionsTable,
  executionsTable,
  executionInteractionsTable,
  executionStepsTable,
};

export type DrizzleTables = typeof drizzleSchema;
