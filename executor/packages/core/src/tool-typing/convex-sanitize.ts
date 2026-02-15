import type { JsonSchema } from "../types";

function stripDollarKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripDollarKeysDeep);
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith("$")) continue;
      out[key] = stripDollarKeysDeep(child);
    }
    return out;
  }

  return value;
}

/**
 * Convex value encoding forbids field names starting with `$`.
 * JSON Schema frequently contains `$ref`, `$schema`, `$id`, etc.
 *
 * This returns a best-effort schema subset safe to return from Convex actions
 * and to store in task outputs.
 */
export function sanitizeJsonSchemaForConvex(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const cleaned = stripDollarKeysDeep(schema);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) return {};
  return cleaned as JsonSchema;
}
