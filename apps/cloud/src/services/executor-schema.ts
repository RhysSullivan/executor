import { pgTable, varchar, text, boolean, timestamp, uniqueIndex, json, bigint } from "drizzle-orm/pg-core"
import { createId } from "fumadb/cuid"

export const source = pgTable("source", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  plugin_id: text("plugin_id").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  url: text("url"),
  can_remove: boolean("can_remove").notNull().default(true),
  can_refresh: boolean("can_refresh").notNull().default(false),
  can_edit: boolean("can_edit").notNull().default(false),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull()
}, (table) => [
  uniqueIndex("source_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const tool = pgTable("tool", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  plugin_id: text("plugin_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  input_schema: json("input_schema"),
  output_schema: json("output_schema"),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull()
}, (table) => [
  uniqueIndex("tool_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const definition = pgTable("definition", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  plugin_id: text("plugin_id").notNull(),
  name: text("name").notNull(),
  schema: json("schema").notNull(),
  created_at: timestamp("created_at").notNull()
}, (table) => [
  uniqueIndex("definition_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const secret = pgTable("secret", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  owned_by_connection_id: text("owned_by_connection_id"),
  created_at: timestamp("created_at").notNull()
}, (table) => [
  uniqueIndex("secret_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const connection = pgTable("connection", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  provider: text("provider").notNull(),
  identity_label: text("identity_label"),
  access_token_secret_id: text("access_token_secret_id").notNull(),
  refresh_token_secret_id: text("refresh_token_secret_id"),
  expires_at: bigint("expires_at", { mode: "bigint" }),
  scope: text("scope"),
  provider_state: json("provider_state"),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull()
}, (table) => [
  uniqueIndex("connection_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const oauth2_session = pgTable("oauth2_session", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  plugin_id: text("plugin_id").notNull(),
  strategy: text("strategy").notNull(),
  connection_id: text("connection_id").notNull(),
  token_scope: text("token_scope").notNull(),
  redirect_url: text("redirect_url").notNull(),
  payload: json("payload").notNull(),
  expires_at: bigint("expires_at", { mode: "bigint" }).notNull(),
  created_at: timestamp("created_at").notNull()
}, (table) => [
  uniqueIndex("oauth2_session_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const credential_binding = pgTable("credential_binding", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  plugin_id: text("plugin_id").notNull(),
  source_id: text("source_id").notNull(),
  source_scope_id: text("source_scope_id").notNull(),
  slot_key: text("slot_key").notNull(),
  kind: text("kind").notNull(),
  text_value: text("text_value"),
  secret_id: text("secret_id"),
  secret_scope_id: text("secret_scope_id"),
  connection_id: text("connection_id"),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull()
}, (table) => [
  uniqueIndex("credential_binding_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const tool_policy = pgTable("tool_policy", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  pattern: text("pattern").notNull(),
  action: text("action").notNull(),
  position: text("position").notNull(),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull()
}, (table) => [
  uniqueIndex("tool_policy_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const blob = pgTable("blob", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  namespace: text("namespace").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull()
}, (table) => [
  uniqueIndex("blob_id_uidx").on(table.id)
])

export const openapi_source = pgTable("openapi_source", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  name: text("name").notNull(),
  spec: text("spec").notNull(),
  source_url: text("source_url"),
  base_url: text("base_url"),
  oauth2: json("oauth2")
}, (table) => [
  uniqueIndex("openapi_source_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const openapi_operation = pgTable("openapi_operation", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  binding: json("binding").notNull()
}, (table) => [
  uniqueIndex("openapi_operation_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const openapi_source_header = pgTable("openapi_source_header", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  text_value: text("text_value"),
  slot_key: text("slot_key"),
  prefix: text("prefix")
}, (table) => [
  uniqueIndex("openapi_source_header_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const openapi_source_query_param = pgTable("openapi_source_query_param", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  text_value: text("text_value"),
  slot_key: text("slot_key"),
  prefix: text("prefix")
}, (table) => [
  uniqueIndex("openapi_source_query_param_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const openapi_source_spec_fetch_header = pgTable("openapi_source_spec_fetch_header", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  text_value: text("text_value"),
  slot_key: text("slot_key"),
  prefix: text("prefix")
}, (table) => [
  uniqueIndex("openapi_source_spec_fetch_header_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const openapi_source_spec_fetch_query_param = pgTable("openapi_source_spec_fetch_query_param", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  text_value: text("text_value"),
  slot_key: text("slot_key"),
  prefix: text("prefix")
}, (table) => [
  uniqueIndex("openapi_source_spec_fetch_query_param_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const mcp_source = pgTable("mcp_source", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  name: text("name").notNull(),
  config: json("config").notNull(),
  auth_kind: text("auth_kind").notNull().default("none"),
  auth_header_name: text("auth_header_name"),
  auth_header_slot: text("auth_header_slot"),
  auth_header_prefix: text("auth_header_prefix"),
  auth_connection_slot: text("auth_connection_slot"),
  auth_client_id_slot: text("auth_client_id_slot"),
  auth_client_secret_slot: text("auth_client_secret_slot"),
  created_at: timestamp("created_at").notNull()
}, (table) => [
  uniqueIndex("mcp_source_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const mcp_source_header = pgTable("mcp_source_header", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  text_value: text("text_value"),
  slot_key: text("slot_key"),
  prefix: text("prefix")
}, (table) => [
  uniqueIndex("mcp_source_header_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const mcp_source_query_param = pgTable("mcp_source_query_param", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  text_value: text("text_value"),
  slot_key: text("slot_key"),
  prefix: text("prefix")
}, (table) => [
  uniqueIndex("mcp_source_query_param_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const mcp_binding = pgTable("mcp_binding", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  binding: json("binding").notNull(),
  created_at: timestamp("created_at").notNull()
}, (table) => [
  uniqueIndex("mcp_binding_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const graphql_source = pgTable("graphql_source", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(),
  auth_kind: text("auth_kind").notNull().default("none"),
  auth_connection_slot: text("auth_connection_slot")
}, (table) => [
  uniqueIndex("graphql_source_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const graphql_source_header = pgTable("graphql_source_header", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  text_value: text("text_value"),
  slot_key: text("slot_key"),
  prefix: text("prefix")
}, (table) => [
  uniqueIndex("graphql_source_header_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const graphql_source_query_param = pgTable("graphql_source_query_param", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  text_value: text("text_value"),
  slot_key: text("slot_key"),
  prefix: text("prefix")
}, (table) => [
  uniqueIndex("graphql_source_query_param_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const graphql_operation = pgTable("graphql_operation", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  source_id: text("source_id").notNull(),
  binding: json("binding").notNull()
}, (table) => [
  uniqueIndex("graphql_operation_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const workos_vault_metadata = pgTable("workos_vault_metadata", {
  row_id: varchar("row_id", { length: 255 }).primaryKey().notNull().$defaultFn(() => createId()),
  id: varchar("id", { length: 255 }).notNull(),
  scope_id: varchar("scope_id", { length: 255 }).notNull(),
  name: text("name").notNull(),
  purpose: text("purpose"),
  created_at: timestamp("created_at").notNull()
}, (table) => [
  uniqueIndex("workos_vault_metadata_scope_id_id_uidx").on(table.scope_id, table.id)
])

export const private_executor_cloud_settings = pgTable("private_executor_cloud_settings", {
  id: varchar("id", { length: 255 }).primaryKey().notNull(),
  version: varchar("version", { length: 255 }).notNull().default("1.0.0")
})