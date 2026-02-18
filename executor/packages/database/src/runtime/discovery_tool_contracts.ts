import { z } from "zod";

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: z.ZodTypeAny, fallback: JsonSchema): JsonSchema {
  const maybeToJsonSchema = (z as unknown as { toJSONSchema?: (value: z.ZodTypeAny) => unknown }).toJSONSchema;
  if (typeof maybeToJsonSchema === "function") {
    return maybeToJsonSchema(schema) as JsonSchema;
  }

  return fallback;
}

const toolApprovalSchema = z.enum(["auto", "required"]);

export const catalogNamespacesInputSchema = z.object({
  limit: z.coerce.number().optional(),
});

export const catalogNamespaceSchema = z.object({
  namespace: z.string(),
  toolCount: z.number(),
  samplePaths: z.array(z.string()),
});

export const catalogNamespacesOutputSchema = z.object({
  namespaces: z.array(catalogNamespaceSchema),
  total: z.number(),
});

export const catalogToolsInputSchema = z.object({
  namespace: z.string().optional(),
  query: z.string().optional(),
  limit: z.coerce.number().optional(),
  compact: z.boolean().optional(),
});

export const discoveryTypingSchema = z.object({
  inputSchemaJson: z.string().optional(),
  outputSchemaJson: z.string().optional(),
  previewInputKeys: z.array(z.string()).optional(),
  refHintKeys: z.array(z.string()).optional(),
});

export const discoveryResultSchema = z.object({
  path: z.string(),
  source: z.string().optional(),
  approval: toolApprovalSchema,
  description: z.string().optional(),
  inputHint: z.string().optional(),
  outputHint: z.string().optional(),
  typing: discoveryTypingSchema.optional(),
});

export const catalogToolsOutputSchema = z.object({
  results: z.array(discoveryResultSchema),
  total: z.number(),
  refHintTable: z.record(z.string()).optional(),
});

export const discoverInputSchema = z.object({
  query: z.string().optional(),
  limit: z.coerce.number().optional(),
  compact: z.boolean().optional(),
});

export const discoverOutputSchema = z.object({
  bestPath: z.string().nullable(),
  results: z.array(discoveryResultSchema),
  total: z.number(),
  refHintTable: z.record(z.string()).optional(),
});

const discoveryResultJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    source: { type: "string" },
    approval: { type: "string", enum: ["auto", "required"] },
    description: { type: "string" },
    inputHint: { type: "string" },
    outputHint: { type: "string" },
    typing: {
      type: "object",
      properties: {
        inputSchemaJson: { type: "string" },
        outputSchemaJson: { type: "string" },
        previewInputKeys: { type: "array", items: { type: "string" } },
        refHintKeys: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  required: ["path", "approval"],
  additionalProperties: false,
};

export const catalogNamespacesInputJsonSchema = toJsonSchema(catalogNamespacesInputSchema, {
  type: "object",
  properties: {
    limit: { type: "number" },
  },
  additionalProperties: false,
});

export const catalogNamespacesOutputJsonSchema = toJsonSchema(catalogNamespacesOutputSchema, {
  type: "object",
  properties: {
    namespaces: {
      type: "array",
      items: {
        type: "object",
        properties: {
          namespace: { type: "string" },
          toolCount: { type: "number" },
          samplePaths: { type: "array", items: { type: "string" } },
        },
        required: ["namespace", "toolCount", "samplePaths"],
        additionalProperties: false,
      },
    },
    total: { type: "number" },
  },
  required: ["namespaces", "total"],
  additionalProperties: false,
});

export const catalogToolsInputJsonSchema = toJsonSchema(catalogToolsInputSchema, {
  type: "object",
  properties: {
    namespace: { type: "string" },
    query: { type: "string" },
    limit: { type: "number" },
    compact: { type: "boolean" },
  },
  additionalProperties: false,
});

export const catalogToolsOutputJsonSchema = toJsonSchema(catalogToolsOutputSchema, {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: discoveryResultJsonSchema,
    },
    total: { type: "number" },
    refHintTable: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
  required: ["results", "total"],
  additionalProperties: false,
});

export const discoverInputJsonSchema = toJsonSchema(discoverInputSchema, {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "number" },
    compact: { type: "boolean" },
  },
  additionalProperties: false,
});

export const discoverOutputJsonSchema = toJsonSchema(discoverOutputSchema, {
  type: "object",
  properties: {
    bestPath: {
      oneOf: [{ type: "string" }, { type: "null" }],
    },
    results: {
      type: "array",
      items: discoveryResultJsonSchema,
    },
    total: { type: "number" },
    refHintTable: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
  required: ["bestPath", "results", "total"],
  additionalProperties: false,
});
