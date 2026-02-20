import { z } from "zod";

type JsonSchema = Record<string, unknown>;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSchemaWithFallback(schema: unknown, fallback: JsonSchema): JsonSchema {
  if (!isRecord(schema)) {
    return fallback;
  }

  const merged: JsonSchema = { ...schema };

  if (typeof fallback.description === "string" && typeof merged.description !== "string") {
    merged.description = fallback.description;
  }

  const schemaProps = isRecord(merged.properties) ? { ...merged.properties } : {};
  const fallbackProps = isRecord(fallback.properties) ? fallback.properties : {};
  for (const [key, fallbackProp] of Object.entries(fallbackProps)) {
    const currentProp = schemaProps[key];
    if (!isRecord(currentProp)) {
      schemaProps[key] = fallbackProp;
      continue;
    }

    if (isRecord(fallbackProp)) {
      schemaProps[key] = {
        ...fallbackProp,
        ...currentProp,
        ...(typeof fallbackProp.description === "string" && typeof currentProp.description !== "string"
          ? { description: fallbackProp.description }
          : {}),
      };
    }
  }
  if (Object.keys(schemaProps).length > 0) {
    merged.properties = schemaProps;
  }

  if (!Array.isArray(merged.required) && Array.isArray(fallback.required)) {
    merged.required = fallback.required;
  }
  if (!("additionalProperties" in merged) && "additionalProperties" in fallback) {
    merged.additionalProperties = fallback.additionalProperties;
  }

  return merged;
}

function toJsonSchema(schema: z.ZodTypeAny, fallback: JsonSchema): JsonSchema {
  const maybeToJsonSchema = (z as unknown as { toJSONSchema?: (value: z.ZodTypeAny) => unknown }).toJSONSchema;
  if (typeof maybeToJsonSchema === "function") {
    try {
      return mergeSchemaWithFallback(maybeToJsonSchema(schema), fallback);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

export const storageScopeSchema = z.enum(["scratch", "account", "workspace", "organization"]);
export const storageDurabilitySchema = z.enum(["ephemeral", "durable"]);
export const storageStatusSchema = z.enum(["active", "closed", "deleted"]);
export const storageProviderSchema = z.enum(["agentfs-local", "agentfs-cloudflare"]);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

export const storageInstanceSchema = z.object({
  id: z.string(),
  scopeType: storageScopeSchema,
  durability: storageDurabilitySchema,
  status: storageStatusSchema,
  provider: storageProviderSchema,
  backendKey: z.string(),
  organizationId: z.string(),
  workspaceId: z.string().optional(),
  accountId: z.string().optional(),
  createdByAccountId: z.string().optional(),
  purpose: z.string().optional(),
  sizeBytes: z.number().optional(),
  fileCount: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastSeenAt: z.number(),
  closedAt: z.number().optional(),
  expiresAt: z.number().optional(),
});

export const storageOpenInputSchema = z.object({
  instanceId: z.string().optional(),
  scopeType: storageScopeSchema.optional(),
  durability: storageDurabilitySchema.optional(),
  purpose: z.string().optional(),
  ttlHours: z.coerce.number().optional(),
});

export const storageOpenOutputSchema = z.object({
  instance: storageInstanceSchema,
});

export const storageListInputSchema = z.object({
  scopeType: storageScopeSchema.optional(),
  includeDeleted: z.boolean().optional(),
});

export const storageListOutputSchema = z.object({
  instances: z.array(storageInstanceSchema),
  total: z.number(),
});

export const storageCloseInputSchema = z.object({
  instanceId: z.string(),
});

export const storageCloseOutputSchema = z.object({
  instance: storageInstanceSchema.nullable(),
});

export const storageDeleteInputSchema = z.object({
  instanceId: z.string(),
});

export const storageDeleteOutputSchema = z.object({
  instance: storageInstanceSchema.nullable(),
});

const fsAccessSchema = z.object({
  instanceId: z.string().optional(),
  scopeType: storageScopeSchema.optional(),
});

export const fsReadInputSchema = fsAccessSchema.extend({
  path: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

export const fsReadOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  content: z.string(),
  bytes: z.number(),
});

export const fsWriteInputSchema = fsAccessSchema.extend({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

export const fsWriteOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  bytesWritten: z.number(),
});

export const fsReaddirInputSchema = fsAccessSchema.extend({
  path: z.string().optional(),
});

export const fsReaddirOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  entries: z.array(z.object({
    name: z.string(),
    type: z.enum(["file", "directory", "symlink", "unknown"]),
    size: z.number().optional(),
    mtime: z.number().optional(),
  })),
});

export const fsStatInputSchema = fsAccessSchema.extend({
  path: z.string(),
});

export const fsStatOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  exists: z.boolean(),
  type: z.enum(["file", "directory", "symlink", "unknown"]).optional(),
  size: z.number().optional(),
  mode: z.number().optional(),
  mtime: z.number().optional(),
  ctime: z.number().optional(),
});

export const fsMkdirInputSchema = fsAccessSchema.extend({
  path: z.string(),
});

export const fsMkdirOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  ok: z.boolean(),
});

export const fsRemoveInputSchema = fsAccessSchema.extend({
  path: z.string(),
  recursive: z.boolean().optional(),
  force: z.boolean().optional(),
});

export const fsRemoveOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  ok: z.boolean(),
});

export const kvGetInputSchema = fsAccessSchema.extend({
  key: z.string(),
});

export const kvGetOutputSchema = z.object({
  instanceId: z.string(),
  key: z.string(),
  found: z.boolean(),
  value: jsonValueSchema.optional(),
});

export const kvSetInputSchema = fsAccessSchema.extend({
  key: z.string(),
  value: jsonValueSchema,
});

export const kvSetOutputSchema = z.object({
  instanceId: z.string(),
  key: z.string(),
  ok: z.boolean(),
});

export const kvListInputSchema = fsAccessSchema.extend({
  prefix: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const kvListOutputSchema = z.object({
  instanceId: z.string(),
  items: z.array(z.object({ key: z.string(), value: jsonValueSchema })),
  total: z.number(),
});

export const kvDeleteInputSchema = fsAccessSchema.extend({
  key: z.string(),
});

export const kvDeleteOutputSchema = z.object({
  instanceId: z.string(),
  key: z.string(),
  ok: z.boolean(),
});

export const kvIncrInputSchema = fsAccessSchema.extend({
  key: z.string(),
  by: z.coerce.number().optional(),
  initial: z.coerce.number().optional(),
});

export const kvIncrOutputSchema = z.object({
  instanceId: z.string(),
  key: z.string(),
  by: z.number(),
  previous: z.number(),
  value: z.number(),
});

export const sqliteQueryInputSchema = fsAccessSchema.extend({
  sql: z.string(),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  mode: z.enum(["read", "write"]).optional(),
  maxRows: z.coerce.number().optional(),
});

export const sqliteQueryOutputSchema = z.object({
  instanceId: z.string(),
  mode: z.enum(["read", "write"]),
  rows: z.array(z.record(jsonValueSchema)).optional(),
  rowCount: z.number(),
  changes: z.number().optional(),
});

const sqliteScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const sqliteCapabilitiesInputSchema = fsAccessSchema.extend({});

export const sqliteCapabilitiesOutputSchema = z.object({
  instanceId: z.string(),
  provider: storageProviderSchema,
  maxBindVariables: z.number(),
  supportsJsonEach: z.boolean(),
  supportsInsertRowsTool: z.boolean(),
  guidance: z.array(z.string()),
});

export const sqliteInsertRowsInputSchema = fsAccessSchema.extend({
  table: z.string(),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(sqliteScalarSchema)).min(1),
  onConflict: z.enum(["none", "ignore", "replace"]).optional(),
  chunkSize: z.coerce.number().optional(),
});

export const sqliteInsertRowsOutputSchema = z.object({
  instanceId: z.string(),
  table: z.string(),
  columns: z.array(z.string()),
  rowsReceived: z.number(),
  rowsProcessed: z.number(),
  chunkCount: z.number(),
  rowsPerChunk: z.number(),
  maxBindVariables: z.number(),
  changes: z.number(),
});

const jsonValueJsonSchema = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "array", items: {} },
    { type: "object", additionalProperties: {} },
  ],
};

export const storageOpenInputJsonSchema = toJsonSchema(storageOpenInputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    scopeType: { type: "string", enum: ["scratch", "account", "workspace", "organization"] },
    durability: { type: "string", enum: ["ephemeral", "durable"] },
    purpose: { type: "string" },
    ttlHours: { type: "number" },
  },
  additionalProperties: false,
});

export const storageOpenOutputJsonSchema = toJsonSchema(storageOpenOutputSchema, {
  type: "object",
  properties: {
    instance: { type: "object" },
  },
  required: ["instance"],
  additionalProperties: false,
});

export const storageListInputJsonSchema = toJsonSchema(storageListInputSchema, {
  type: "object",
  properties: {
    scopeType: { type: "string", enum: ["scratch", "account", "workspace", "organization"] },
    includeDeleted: { type: "boolean" },
  },
  additionalProperties: false,
});

export const storageListOutputJsonSchema = toJsonSchema(storageListOutputSchema, {
  type: "object",
  properties: {
    instances: { type: "array", items: { type: "object" } },
    total: { type: "number" },
  },
  required: ["instances", "total"],
  additionalProperties: false,
});

export const storageCloseInputJsonSchema = toJsonSchema(storageCloseInputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
  },
  required: ["instanceId"],
  additionalProperties: false,
});

export const storageCloseOutputJsonSchema = toJsonSchema(storageCloseOutputSchema, {
  type: "object",
  properties: {
    instance: {
      oneOf: [{ type: "object" }, { type: "null" }],
    },
  },
  required: ["instance"],
  additionalProperties: false,
});

export const storageDeleteInputJsonSchema = storageCloseInputJsonSchema;
export const storageDeleteOutputJsonSchema = storageCloseOutputJsonSchema;

function fsAccessJsonProperties() {
  return {
    instanceId: {
      type: "string",
      description: "Storage instance identifier. Recommended for cross-task/cross-run persistence.",
    },
    scopeType: {
      type: "string",
      enum: ["scratch", "account", "workspace", "organization"],
      description: "Scope used to open/select a default instance when instanceId is omitted.",
    },
  };
}

export const fsReadInputJsonSchema = toJsonSchema(fsReadInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
    encoding: { type: "string", enum: ["utf8", "base64"] },
  },
  required: ["path"],
  additionalProperties: false,
});

export const fsReadOutputJsonSchema = toJsonSchema(fsReadOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    encoding: { type: "string", enum: ["utf8", "base64"] },
    content: { type: "string" },
    bytes: { type: "number" },
  },
  required: ["instanceId", "path", "encoding", "content", "bytes"],
  additionalProperties: false,
});

export const fsWriteInputJsonSchema = toJsonSchema(fsWriteInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
    content: { type: "string" },
    encoding: { type: "string", enum: ["utf8", "base64"] },
  },
  required: ["path", "content"],
  additionalProperties: false,
});

export const fsWriteOutputJsonSchema = toJsonSchema(fsWriteOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    bytesWritten: { type: "number" },
  },
  required: ["instanceId", "path", "bytesWritten"],
  additionalProperties: false,
});

export const fsReaddirInputJsonSchema = toJsonSchema(fsReaddirInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
  },
  additionalProperties: false,
});

export const fsReaddirOutputJsonSchema = toJsonSchema(fsReaddirOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    entries: { type: "array", items: { type: "object" } },
  },
  required: ["instanceId", "path", "entries"],
  additionalProperties: false,
});

export const fsStatInputJsonSchema = toJsonSchema(fsStatInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
  },
  required: ["path"],
  additionalProperties: false,
});

export const fsStatOutputJsonSchema = toJsonSchema(fsStatOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    exists: { type: "boolean" },
    type: { type: "string", enum: ["file", "directory", "symlink", "unknown"] },
    size: { type: "number" },
    mode: { type: "number" },
    mtime: { type: "number" },
    ctime: { type: "number" },
  },
  required: ["instanceId", "path", "exists"],
  additionalProperties: false,
});

export const fsMkdirInputJsonSchema = toJsonSchema(fsMkdirInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
  },
  required: ["path"],
  additionalProperties: false,
});

export const fsMkdirOutputJsonSchema = toJsonSchema(fsMkdirOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["instanceId", "path", "ok"],
  additionalProperties: false,
});

export const fsRemoveInputJsonSchema = toJsonSchema(fsRemoveInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
    recursive: { type: "boolean" },
    force: { type: "boolean" },
  },
  required: ["path"],
  additionalProperties: false,
});

export const fsRemoveOutputJsonSchema = toJsonSchema(fsRemoveOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["instanceId", "path", "ok"],
  additionalProperties: false,
});

export const kvGetInputJsonSchema = toJsonSchema(kvGetInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    key: { type: "string" },
  },
  required: ["key"],
  additionalProperties: false,
});

export const kvGetOutputJsonSchema = toJsonSchema(kvGetOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    key: { type: "string" },
    found: { type: "boolean" },
    value: jsonValueJsonSchema,
  },
  required: ["instanceId", "key", "found"],
  additionalProperties: false,
});

export const kvSetInputJsonSchema = toJsonSchema(kvSetInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    key: { type: "string" },
    value: jsonValueJsonSchema,
  },
  required: ["key", "value"],
  additionalProperties: false,
});

export const kvSetOutputJsonSchema = toJsonSchema(kvSetOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    key: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["instanceId", "key", "ok"],
  additionalProperties: false,
});

export const kvListInputJsonSchema = toJsonSchema(kvListInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    prefix: { type: "string" },
    limit: { type: "number" },
  },
  additionalProperties: false,
});

export const kvListOutputJsonSchema = toJsonSchema(kvListOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: jsonValueJsonSchema,
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
    total: { type: "number" },
  },
  required: ["instanceId", "items", "total"],
  additionalProperties: false,
});

export const kvDeleteInputJsonSchema = toJsonSchema(kvDeleteInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    key: { type: "string" },
  },
  required: ["key"],
  additionalProperties: false,
});

export const kvDeleteOutputJsonSchema = toJsonSchema(kvDeleteOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    key: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["instanceId", "key", "ok"],
  additionalProperties: false,
});

export const kvIncrInputJsonSchema = toJsonSchema(kvIncrInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    key: { type: "string" },
    by: { type: "number" },
    initial: { type: "number" },
  },
  required: ["key"],
  additionalProperties: false,
});

export const kvIncrOutputJsonSchema = toJsonSchema(kvIncrOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    key: { type: "string" },
    by: { type: "number" },
    previous: { type: "number" },
    value: { type: "number" },
  },
  required: ["instanceId", "key", "by", "previous", "value"],
  additionalProperties: false,
});

export const sqliteQueryInputJsonSchema = toJsonSchema(sqliteQueryInputSchema, {
  type: "object",
  description:
    "Execute SQL on a storage-backed SQLite database. Use instanceId to target the same database across separate tasks or sessions.",
  properties: {
    ...fsAccessJsonProperties(),
    sql: { type: "string", description: "SQL statement text to execute." },
    params: {
      type: "array",
      description:
        "Positional SQL parameters. Keep per-call bind count modest (for large inserts, batch rows into smaller chunks or pass one JSON payload and expand with json_each(?)).",
      items: {
        oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
      },
    },
    mode: {
      type: "string",
      enum: ["read", "write"],
      description: "Use 'write' for CREATE/INSERT/UPDATE/DELETE statements.",
    },
    maxRows: { type: "number", description: "Read mode row cap for result payload size." },
  },
  required: ["sql"],
  additionalProperties: false,
});

export const sqliteQueryOutputJsonSchema = toJsonSchema(sqliteQueryOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    mode: { type: "string", enum: ["read", "write"] },
    rows: { type: "array", items: { type: "object", additionalProperties: jsonValueJsonSchema } },
    rowCount: { type: "number" },
    changes: { type: "number" },
  },
  required: ["instanceId", "mode", "rowCount"],
  additionalProperties: false,
});

export const sqliteCapabilitiesInputJsonSchema = toJsonSchema(sqliteCapabilitiesInputSchema, {
  type: "object",
  description: "Get provider-specific SQLite execution capabilities and batching guidance.",
  properties: {
    ...fsAccessJsonProperties(),
  },
  additionalProperties: false,
});

export const sqliteCapabilitiesOutputJsonSchema = toJsonSchema(sqliteCapabilitiesOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    provider: { type: "string", enum: ["agentfs-local", "agentfs-cloudflare"] },
    maxBindVariables: { type: "number" },
    supportsJsonEach: { type: "boolean" },
    supportsInsertRowsTool: { type: "boolean" },
    guidance: { type: "array", items: { type: "string" } },
  },
  required: [
    "instanceId",
    "provider",
    "maxBindVariables",
    "supportsJsonEach",
    "supportsInsertRowsTool",
    "guidance",
  ],
  additionalProperties: false,
});

export const sqliteInsertRowsInputJsonSchema = toJsonSchema(sqliteInsertRowsInputSchema, {
  type: "object",
  description:
    "Insert tabular rows with automatic chunking to stay under SQLite bind-variable limits. Prefer this over huge VALUES(...) statements.",
  properties: {
    ...fsAccessJsonProperties(),
    table: { type: "string", description: "Target table name." },
    columns: { type: "array", items: { type: "string" }, minItems: 1 },
    rows: {
      type: "array",
      minItems: 1,
      items: {
        type: "array",
        items: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] },
      },
    },
    onConflict: { type: "string", enum: ["none", "ignore", "replace"] },
    chunkSize: { type: "number", description: "Optional max rows per insert chunk." },
  },
  required: ["table", "columns", "rows"],
  additionalProperties: false,
});

export const sqliteInsertRowsOutputJsonSchema = toJsonSchema(sqliteInsertRowsOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    table: { type: "string" },
    columns: { type: "array", items: { type: "string" } },
    rowsReceived: { type: "number" },
    rowsProcessed: { type: "number" },
    chunkCount: { type: "number" },
    rowsPerChunk: { type: "number" },
    maxBindVariables: { type: "number" },
    changes: { type: "number" },
  },
  required: [
    "instanceId",
    "table",
    "columns",
    "rowsReceived",
    "rowsProcessed",
    "chunkCount",
    "rowsPerChunk",
    "maxBindVariables",
    "changes",
  ],
  additionalProperties: false,
});
