import { blob, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").notNull(),
    scopeId: text("scope_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.scopeId] })],
);

export const tools = sqliteTable(
  "tools",
  {
    id: text("id").notNull(),
    scopeId: text("scope_id").notNull(),
    sourceId: text("source_id").notNull(),
    pluginKey: text("plugin_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    mayElicit: integer("may_elicit", { mode: "boolean" }).$default(() => false),
    inputSchema: text("input_schema", { mode: "json" }).$type<unknown>(),
    outputSchema: text("output_schema", { mode: "json" }).$type<unknown>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$default(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.scopeId] }),
    index("idx_tools_source").on(table.scopeId, table.sourceId),
  ],
);

export const toolDefinitions = sqliteTable(
  "tool_definitions",
  {
    name: text("name").notNull(),
    scopeId: text("scope_id").notNull(),
    schema: text("schema", { mode: "json" }).$type<unknown>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.name, table.scopeId] })],
);

export const secrets = sqliteTable(
  "secrets",
  {
    id: text("id").notNull(),
    scopeId: text("scope_id").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose"),
    provider: text("provider"),
    encryptedValue: blob("encrypted_value", { mode: "buffer" }),
    iv: blob("iv", { mode: "buffer" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$default(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.id, table.scopeId] })],
);

export const policies = sqliteTable(
  "policies",
  {
    id: text("id").notNull(),
    scopeId: text("scope_id").notNull(),
    name: text("name").notNull(),
    action: text("action").notNull(),
    matchToolPattern: text("match_tool_pattern"),
    matchSourceId: text("match_source_id"),
    priority: integer("priority").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$default(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.id, table.scopeId] })],
);

export const pluginKv = sqliteTable(
  "plugin_kv",
  {
    scopeId: text("scope_id").notNull(),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeId, table.namespace, table.key] }),
    index("idx_plugin_kv_namespace").on(table.scopeId, table.namespace),
  ],
);
