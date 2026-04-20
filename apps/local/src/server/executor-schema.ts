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
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull()
}, (table) => [
  primaryKey({ columns: [table.scope_id, table.id] }),
  index("secret_scope_id_idx").on(table.scope_id),
  index("secret_provider_idx").on(table.provider),
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

export const blob = sqliteTable("blob", {
  namespace: text('namespace').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, (table) => [
  primaryKey({ columns: [table.namespace, table.key] }),
]);

