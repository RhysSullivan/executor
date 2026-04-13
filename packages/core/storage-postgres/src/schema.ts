import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  customType,
  primaryKey,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Custom type — bytea for encrypted secret storage
// ---------------------------------------------------------------------------

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ---------------------------------------------------------------------------
// Domain data — all organization-scoped
// ---------------------------------------------------------------------------

export const sources = pgTable(
  "sources",
  {
    id: text("id").notNull(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    config: jsonb("config")
      .notNull()
      .$default(() => ({})),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.organizationId] })],
);

export const tools = pgTable(
  "tools",
  {
    id: text("id").notNull(),
    organizationId: text("organization_id").notNull(),
    sourceId: text("source_id").notNull(),
    pluginKey: text("plugin_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    mayElicit: boolean("may_elicit").$default(() => false),
    inputSchema: jsonb("input_schema"),
    outputSchema: jsonb("output_schema"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.organizationId] })],
);

export const toolDefinitions = pgTable(
  "tool_definitions",
  {
    name: text("name").notNull(),
    organizationId: text("organization_id").notNull(),
    schema: jsonb("schema").notNull(),
  },
  (table) => [primaryKey({ columns: [table.name, table.organizationId] })],
);

export const secrets = pgTable(
  "secrets",
  {
    id: text("id").notNull(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose"),
    encryptedValue: bytea("encrypted_value").notNull(),
    iv: bytea("iv").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.organizationId] })],
);

export const policies = pgTable(
  "policies",
  {
    id: text("id").notNull(),
    organizationId: text("organization_id").notNull(),
    toolPattern: text("tool_pattern").notNull(),
    effect: text("effect").notNull(),
    approvalMode: text("approval_mode").notNull(),
    priority: integer("priority")
      .notNull()
      .$default(() => 0),
    enabled: boolean("enabled")
      .notNull()
      .$default(() => true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.organizationId] })],
);

// ---------------------------------------------------------------------------
// Plugin KV — escape hatch for plugin-specific data
// ---------------------------------------------------------------------------

export const pluginKv = pgTable(
  "plugin_kv",
  {
    organizationId: text("organization_id").notNull(),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.namespace, table.key] })],
);
