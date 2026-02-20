import { z } from "zod";

export type JsonSchema = Record<string, unknown>;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

export function toJsonSchema(schema: z.ZodTypeAny, fallback: JsonSchema): JsonSchema {
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

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

export const jsonValueJsonSchema = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "array", items: {} },
    { type: "object", additionalProperties: {} },
  ],
};

export const fsAccessSchema = z.object({
  instanceId: z.string().optional(),
  scopeType: storageScopeSchema.optional(),
});

export function fsAccessJsonProperties() {
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
