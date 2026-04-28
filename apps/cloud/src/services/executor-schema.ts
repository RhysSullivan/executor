import { pgTable, text, boolean, timestamp, bigint, jsonb, index, primaryKey } from "drizzle-orm/pg-core";

export const source = pgTable("source", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  plugin_id: text('plugin_id').notNull(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  url: text('url'),
  can_remove: boolean('can_remove').default(true).notNull(),
  can_refresh: boolean('can_refresh').default(false).notNull(),
  can_edit: boolean('can_edit').default(false).notNull(),
  created_at: timestamp('created_at').notNull(),
  updated_at: timestamp('updated_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("source_scope_id_idx").on(table.scope_id),
  index("source_plugin_id_idx").on(table.plugin_id),
]);

export const tool = pgTable("tool", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  plugin_id: text('plugin_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  input_schema: jsonb('input_schema'),
  output_schema: jsonb('output_schema'),
  created_at: timestamp('created_at').notNull(),
  updated_at: timestamp('updated_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("tool_scope_id_idx").on(table.scope_id),
  index("tool_source_id_idx").on(table.source_id),
  index("tool_plugin_id_idx").on(table.plugin_id),
]);

export const definition = pgTable("definition", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  plugin_id: text('plugin_id').notNull(),
  name: text('name').notNull(),
  schema: jsonb('schema').notNull(),
  created_at: timestamp('created_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("definition_scope_id_idx").on(table.scope_id),
  index("definition_source_id_idx").on(table.source_id),
  index("definition_plugin_id_idx").on(table.plugin_id),
]);

export const secret = pgTable("secret", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  owned_by_connection_id: text('owned_by_connection_id'),
  created_at: timestamp('created_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("secret_scope_id_idx").on(table.scope_id),
  index("secret_provider_idx").on(table.provider),
  index("secret_owned_by_connection_id_idx").on(table.owned_by_connection_id),
]);

export const connection = pgTable("connection", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  provider: text('provider').notNull(),
  identity_label: text('identity_label'),
  access_token_secret_id: text('access_token_secret_id').notNull(),
  refresh_token_secret_id: text('refresh_token_secret_id'),
  expires_at: bigint('expires_at', { mode: 'number' }),
  scope: text('scope'),
  provider_state: jsonb('provider_state'),
  created_at: timestamp('created_at').notNull(),
  updated_at: timestamp('updated_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("connection_scope_id_idx").on(table.scope_id),
  index("connection_provider_idx").on(table.provider),
]);

export const openapi_source = pgTable("openapi_source", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  name: text('name').notNull(),
  spec: text('spec').notNull(),
  source_url: text('source_url'),
  base_url: text('base_url'),
  headers: jsonb('headers'),
  oauth2: jsonb('oauth2'),
  invocation_config: jsonb('invocation_config').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("openapi_source_scope_id_idx").on(table.scope_id),
]);

export const openapi_source_binding = pgTable("openapi_source_binding", {
  id: text('id').notNull(),
  source_id: text('source_id').notNull(),
  source_scope_id: text('source_scope_id').notNull(),
  target_scope_id: text('target_scope_id').notNull(),
  slot: text('slot').notNull(),
  value: jsonb('value').notNull(),
  created_at: timestamp('created_at').notNull(),
  updated_at: timestamp('updated_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.id] }),
  index("openapi_source_binding_source_id_idx").on(table.source_id),
  index("openapi_source_binding_source_scope_id_idx").on(table.source_scope_id),
  index("openapi_source_binding_target_scope_id_idx").on(table.target_scope_id),
  index("openapi_source_binding_slot_idx").on(table.slot),
]);

export const openapi_operation = pgTable("openapi_operation", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  binding: jsonb('binding').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("openapi_operation_scope_id_idx").on(table.scope_id),
  index("openapi_operation_source_id_idx").on(table.source_id),
]);

export const openapi_oauth_session = pgTable("openapi_oauth_session", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  session: jsonb('session').notNull(),
  created_at: timestamp('created_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("openapi_oauth_session_scope_id_idx").on(table.scope_id),
]);

export const mcp_source = pgTable("mcp_source", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  name: text('name').notNull(),
  config: jsonb('config').notNull(),
  created_at: timestamp('created_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("mcp_source_scope_id_idx").on(table.scope_id),
]);

export const mcp_binding = pgTable("mcp_binding", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  binding: jsonb('binding').notNull(),
  created_at: timestamp('created_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("mcp_binding_scope_id_idx").on(table.scope_id),
  index("mcp_binding_source_id_idx").on(table.source_id),
]);

export const mcp_oauth_session = pgTable("mcp_oauth_session", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  session: jsonb('session').notNull(),
  expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
  created_at: timestamp('created_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("mcp_oauth_session_scope_id_idx").on(table.scope_id),
]);

export const graphql_source = pgTable("graphql_source", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  name: text('name').notNull(),
  endpoint: text('endpoint').notNull(),
  headers: jsonb('headers')
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("graphql_source_scope_id_idx").on(table.scope_id),
]);

export const graphql_operation = pgTable("graphql_operation", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  binding: jsonb('binding').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("graphql_operation_scope_id_idx").on(table.scope_id),
  index("graphql_operation_source_id_idx").on(table.source_id),
]);

export const workos_vault_metadata = pgTable("workos_vault_metadata", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  name: text('name').notNull(),
  purpose: text('purpose'),
  created_at: timestamp('created_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("workos_vault_metadata_scope_id_idx").on(table.scope_id),
]);

// Execution history — one row per engine.execute() / executeWithPause()
// call. `scope_id` is the innermost executor scope that owned the run;
// the scoped adapter filters these on every list query. JSON-bearing
// columns (result/error/logs/trigger-meta) are text blobs; the SDK
// never parses them server-side.
export const execution = pgTable("execution", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  status: text('status').notNull(),
  code: text('code').notNull(),
  result_json: text('result_json'),
  error_text: text('error_text'),
  logs_json: text('logs_json'),
  started_at: bigint('started_at', { mode: 'number' }),
  completed_at: bigint('completed_at', { mode: 'number' }),
  trigger_kind: text('trigger_kind'),
  trigger_meta_json: text('trigger_meta_json'),
  tool_call_count: bigint('tool_call_count', { mode: 'number' }).default(0).notNull(),
  created_at: timestamp('created_at').notNull(),
  updated_at: timestamp('updated_at').notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("execution_scope_id_idx").on(table.scope_id),
  index("execution_status_idx").on(table.status),
  index("execution_trigger_kind_idx").on(table.trigger_kind),
  index("execution_created_at_idx").on(table.created_at),
]);

// Per-execution interaction rows — elicitation requests + their
// resolutions. Not scope-owned; tenant isolation flows through the
// parent execution.
export const execution_interaction = pgTable("execution_interaction", {
  id: text('id').primaryKey(),
  execution_id: text('execution_id').notNull(),
  status: text('status').notNull(),
  kind: text('kind').notNull(),
  purpose: text('purpose'),
  payload_json: text('payload_json'),
  response_json: text('response_json'),
  response_private_json: text('response_private_json'),
  created_at: timestamp('created_at').notNull(),
  updated_at: timestamp('updated_at').notNull()
}, (table) => [
  index("execution_interaction_execution_id_idx").on(table.execution_id),
  index("execution_interaction_status_idx").on(table.status),
]);

// Per-execution tool-call rows — one per executor.tools.invoke call
// inside the sandboxed execution. Powers the runs UI's tool-call
// timeline + facet list.
export const execution_tool_call = pgTable("execution_tool_call", {
  id: text('id').primaryKey(),
  execution_id: text('execution_id').notNull(),
  status: text('status').notNull(),
  tool_path: text('tool_path').notNull(),
  namespace: text('namespace'),
  args_json: text('args_json'),
  result_json: text('result_json'),
  error_text: text('error_text'),
  started_at: bigint('started_at', { mode: 'number' }).notNull(),
  completed_at: bigint('completed_at', { mode: 'number' }),
  duration_ms: bigint('duration_ms', { mode: 'number' })
}, (table) => [
  index("execution_tool_call_execution_id_idx").on(table.execution_id),
  index("execution_tool_call_tool_path_idx").on(table.tool_path),
  index("execution_tool_call_namespace_idx").on(table.namespace),
]);

// Blob store table — hand-appended. BlobStore is a separate storage
// abstraction from DBSchema, so the CLI doesn't generate it. Keep in
// sync with @executor/storage-postgres's BlobStore implementation.
export const blob = pgTable("blob", {
  namespace: text('namespace').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, (table) => [
  primaryKey({ columns: [table.namespace, table.key] }),
]);
