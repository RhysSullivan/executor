import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  customType,
  primaryKey,
  index,
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
    name: text("name").notNull(),
    action: text("action").notNull(),
    matchToolPattern: text("match_tool_pattern"),
    matchSourceId: text("match_source_id"),
    priority: integer("priority")
      .notNull()
      .$default(() => 0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

export const executions = pgTable(
  "executions",
  {
    id: text("id").notNull(),
    organizationId: text("organization_id").notNull(),
    scopeId: text("scope_id").notNull(),
    status: text("status").notNull(),
    code: text("code").notNull(),
    resultJson: text("result_json"),
    errorText: text("error_text"),
    logsJson: text("logs_json"),
    startedAt: bigint("started_at", { mode: "number" }),
    completedAt: bigint("completed_at", { mode: "number" }),
    triggerKind: text("trigger_kind"),
    triggerMetaJson: text("trigger_meta_json"),
    toolCallCount: integer("tool_call_count")
      .notNull()
      .$default(() => 0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.organizationId] }),
    index("executions_scope_created_at_idx").on(table.scopeId, table.createdAt, table.id),
    index("executions_trigger_kind_idx").on(table.organizationId, table.triggerKind),
  ],
);

export const executionInteractions = pgTable(
  "execution_interactions",
  {
    id: text("id").notNull(),
    organizationId: text("organization_id").notNull(),
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
    primaryKey({ columns: [table.id, table.organizationId] }),
    index("execution_interactions_execution_status_idx").on(table.executionId, table.status),
  ],
);

export const executionToolCalls = pgTable(
  "execution_tool_calls",
  {
    id: text("id").notNull(),
    organizationId: text("organization_id").notNull(),
    executionId: text("execution_id").notNull(),
    status: text("status").notNull(),
    toolPath: text("tool_path").notNull(),
    namespace: text("namespace").notNull(),
    argsJson: text("args_json"),
    resultJson: text("result_json"),
    errorText: text("error_text"),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
    durationMs: bigint("duration_ms", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.organizationId] }),
    index("execution_tool_calls_execution_idx").on(
      table.organizationId,
      table.executionId,
      table.startedAt,
    ),
    index("execution_tool_calls_path_idx").on(table.organizationId, table.toolPath),
  ],
);
