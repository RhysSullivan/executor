import { z } from "zod";
import {
  fsAccessJsonProperties,
  fsAccessSchema,
  jsonValueJsonSchema,
  jsonValueSchema,
  storageProviderSchema,
  toJsonSchema,
} from "./shared";

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
