import { relations } from "drizzle-orm";
import { pgTable, text, boolean, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

export const source = pgTable("source", {
  id: text('id').primaryKey(),
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
  index("source_plugin_id_idx").on(table.plugin_id),
]);

export const tool = pgTable("tool", {
  id: text('id').primaryKey(),
  source_id: text('source_id').notNull(),
  plugin_id: text('plugin_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  input_schema: jsonb('input_schema'),
  output_schema: jsonb('output_schema'),
  created_at: timestamp('created_at').notNull(),
  updated_at: timestamp('updated_at').notNull()
}, (table) => [
  index("tool_source_id_idx").on(table.source_id),
  index("tool_plugin_id_idx").on(table.plugin_id),
]);

export const definition = pgTable("definition", {
  id: text('id').primaryKey(),
  source_id: text('source_id').notNull(),
  plugin_id: text('plugin_id').notNull(),
  name: text('name').notNull(),
  schema: jsonb('schema').notNull(),
  created_at: timestamp('created_at').notNull()
}, (table) => [
  index("definition_source_id_idx").on(table.source_id),
  index("definition_plugin_id_idx").on(table.plugin_id),
]);

export const secret = pgTable("secret", {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  created_at: timestamp('created_at').notNull()
}, (table) => [
  index("secret_provider_idx").on(table.provider),
]);

export const openapi_source = pgTable("openapi_source", {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  spec: text('spec').notNull(),
  base_url: text('base_url'),
  headers: jsonb('headers'),
  oauth2: jsonb('oauth2'),
  invocation_config: jsonb('invocation_config').notNull()
});

export const openapi_operation = pgTable("openapi_operation", {
  id: text('id').primaryKey(),
  source_id: text('source_id').notNull(),
  binding: jsonb('binding').notNull()
}, (table) => [
  index("openapi_operation_source_id_idx").on(table.source_id),
]);

export const openapi_oauth_session = pgTable("openapi_oauth_session", {
  id: text('id').primaryKey(),
  session: jsonb('session').notNull(),
  created_at: timestamp('created_at').notNull()
});

export const mcp_source = pgTable("mcp_source", {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: jsonb('config').notNull(),
  created_at: timestamp('created_at').notNull()
});

export const mcp_binding = pgTable("mcp_binding", {
  id: text('id').primaryKey(),
  source_id: text('source_id').notNull(),
  binding: jsonb('binding').notNull(),
  created_at: timestamp('created_at').notNull()
}, (table) => [
  index("mcp_binding_source_id_idx").on(table.source_id),
]);

export const mcp_oauth_session = pgTable("mcp_oauth_session", {
  id: text('id').primaryKey(),
  session: jsonb('session').notNull(),
  expires_at: integer('expires_at').notNull(),
  created_at: timestamp('created_at').notNull()
});

export const graphql_source = pgTable("graphql_source", {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  endpoint: text('endpoint').notNull(),
  headers: jsonb('headers')
});

export const graphql_operation = pgTable("graphql_operation", {
  id: text('id').primaryKey(),
  source_id: text('source_id').notNull(),
  binding: jsonb('binding').notNull()
}, (table) => [
  index("graphql_operation_source_id_idx").on(table.source_id),
]);

export const workos_vault_metadata = pgTable("workos_vault_metadata", {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  purpose: text('purpose'),
  created_at: timestamp('created_at').notNull()
});

