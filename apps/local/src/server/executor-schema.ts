import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

export const source = sqliteTable("source", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  plugin_id: text('plugin_id').notNull(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  url: text('url'),
  can_remove: integer('can_remove', { mode: 'boolean' }).default(true).notNull(),
  can_refresh: integer('can_refresh', { mode: 'boolean' }).default(false).notNull(),
  can_edit: integer('can_edit', { mode: 'boolean' }).default(false).notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("source_scope_id_idx").on(table.scope_id),
  index("source_plugin_id_idx").on(table.plugin_id),
]);

export const tool = sqliteTable("tool", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  plugin_id: text('plugin_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  input_schema: text('input_schema', { mode: "json" }),
  output_schema: text('output_schema', { mode: "json" }),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("tool_scope_id_idx").on(table.scope_id),
  index("tool_source_id_idx").on(table.source_id),
  index("tool_plugin_id_idx").on(table.plugin_id),
]);

export const definition = sqliteTable("definition", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  plugin_id: text('plugin_id').notNull(),
  name: text('name').notNull(),
  schema: text('schema', { mode: "json" }).notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("definition_scope_id_idx").on(table.scope_id),
  index("definition_source_id_idx").on(table.source_id),
  index("definition_plugin_id_idx").on(table.plugin_id),
]);

export const secret = sqliteTable("secret", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  owned_by_connection_id: text('owned_by_connection_id'),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("secret_scope_id_idx").on(table.scope_id),
  index("secret_provider_idx").on(table.provider),
  index("secret_owned_by_connection_id_idx").on(table.owned_by_connection_id),
]);

export const connection = sqliteTable("connection", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  provider: text('provider').notNull(),
  identity_label: text('identity_label'),
  access_token_secret_id: text('access_token_secret_id').notNull(),
  refresh_token_secret_id: text('refresh_token_secret_id'),
  expires_at: integer('expires_at'),
  scope: text('scope'),
  provider_state: text('provider_state', { mode: "json" }),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("connection_scope_id_idx").on(table.scope_id),
  index("connection_provider_idx").on(table.provider),
]);

export const openapi_source = sqliteTable("openapi_source", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  name: text('name').notNull(),
  spec: text('spec').notNull(),
  source_url: text('source_url'),
  base_url: text('base_url'),
  headers: text('headers', { mode: "json" }),
  oauth2: text('oauth2', { mode: "json" }),
  invocation_config: text('invocation_config', { mode: "json" }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("openapi_source_scope_id_idx").on(table.scope_id),
]);

export const openapi_operation = sqliteTable("openapi_operation", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  binding: text('binding', { mode: "json" }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("openapi_operation_scope_id_idx").on(table.scope_id),
  index("openapi_operation_source_id_idx").on(table.source_id),
]);

export const openapi_source_binding = sqliteTable("openapi_source_binding", {
  id: text('id').primaryKey(),
  source_id: text('source_id').notNull(),
  source_scope_id: text('source_scope_id').notNull(),
  target_scope_id: text('target_scope_id').notNull(),
  slot: text('slot').notNull(),
  value: text('value', { mode: "json" }).notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  index("openapi_source_binding_source_id_idx").on(table.source_id),
  index("openapi_source_binding_source_scope_id_idx").on(table.source_scope_id),
  index("openapi_source_binding_target_scope_id_idx").on(table.target_scope_id),
  index("openapi_source_binding_slot_idx").on(table.slot),
]);

export const openapi_oauth_session = sqliteTable("openapi_oauth_session", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  session: text('session', { mode: "json" }).notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("openapi_oauth_session_scope_id_idx").on(table.scope_id),
]);

export const mcp_source = sqliteTable("mcp_source", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  name: text('name').notNull(),
  config: text('config', { mode: "json" }).notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("mcp_source_scope_id_idx").on(table.scope_id),
]);

export const mcp_binding = sqliteTable("mcp_binding", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  binding: text('binding', { mode: "json" }).notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("mcp_binding_scope_id_idx").on(table.scope_id),
  index("mcp_binding_source_id_idx").on(table.source_id),
]);

export const mcp_oauth_session = sqliteTable("mcp_oauth_session", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  session: text('session', { mode: "json" }).notNull(),
  expires_at: integer('expires_at').notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("mcp_oauth_session_scope_id_idx").on(table.scope_id),
]);

export const google_discovery_source = sqliteTable("google_discovery_source", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  name: text('name').notNull(),
  config: text('config', { mode: "json" }).notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("google_discovery_source_scope_id_idx").on(table.scope_id),
]);

export const google_discovery_binding = sqliteTable("google_discovery_binding", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  binding: text('binding', { mode: "json" }).notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("google_discovery_binding_scope_id_idx").on(table.scope_id),
  index("google_discovery_binding_source_id_idx").on(table.source_id),
]);

export const google_discovery_oauth_session = sqliteTable("google_discovery_oauth_session", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  session: text('session', { mode: "json" }).notNull(),
  expires_at: integer('expires_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("google_discovery_oauth_session_scope_id_idx").on(table.scope_id),
]);

export const graphql_source = sqliteTable("graphql_source", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  name: text('name').notNull(),
  endpoint: text('endpoint').notNull(),
  headers: text('headers', { mode: "json" })
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("graphql_source_scope_id_idx").on(table.scope_id),
]);

export const graphql_operation = sqliteTable("graphql_operation", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  source_id: text('source_id').notNull(),
  binding: text('binding', { mode: "json" }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("graphql_operation_scope_id_idx").on(table.scope_id),
  index("graphql_operation_source_id_idx").on(table.source_id),
]);

// Execution history — one row per engine.execute() / executeWithPause()
// call. `scope_id` is the innermost executor scope that owned the run;
// the scoped adapter filters these on every list query. JSON-bearing
// columns (result/error/logs/trigger-meta) are text blobs; the SDK never
// parses them server-side.
export const execution = sqliteTable("execution", {
  id: text('id').notNull(),
  scope_id: text('scope_id').notNull(),
  status: text('status').notNull(),
  code: text('code').notNull(),
  result_json: text('result_json'),
  error_text: text('error_text'),
  logs_json: text('logs_json'),
  started_at: integer('started_at'),
  completed_at: integer('completed_at'),
  trigger_kind: text('trigger_kind'),
  trigger_meta_json: text('trigger_meta_json'),
  tool_call_count: integer('tool_call_count').default(0).notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
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
export const execution_interaction = sqliteTable("execution_interaction", {
  id: text('id').primaryKey(),
  execution_id: text('execution_id').notNull(),
  status: text('status').notNull(),
  kind: text('kind').notNull(),
  purpose: text('purpose'),
  payload_json: text('payload_json'),
  response_json: text('response_json'),
  response_private_json: text('response_private_json'),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  index("execution_interaction_execution_id_idx").on(table.execution_id),
  index("execution_interaction_status_idx").on(table.status),
]);

// Per-execution tool-call rows — one per executor.tools.invoke call
// inside the sandboxed execution. Powers the runs UI's tool-call
// timeline + facet list.
export const execution_tool_call = sqliteTable("execution_tool_call", {
  id: text('id').primaryKey(),
  execution_id: text('execution_id').notNull(),
  status: text('status').notNull(),
  tool_path: text('tool_path').notNull(),
  namespace: text('namespace'),
  args_json: text('args_json'),
  result_json: text('result_json'),
  error_text: text('error_text'),
  started_at: integer('started_at').notNull(),
  completed_at: integer('completed_at'),
  duration_ms: integer('duration_ms')
}, (table) => [
  index("execution_tool_call_execution_id_idx").on(table.execution_id),
  index("execution_tool_call_tool_path_idx").on(table.tool_path),
  index("execution_tool_call_namespace_idx").on(table.namespace),
]);
