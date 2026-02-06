/**
 * Convert JSON Schema to TypeScript type strings.
 *
 * Both MCP tools and OpenAPI specs use JSON Schema for their type definitions.
 * This module converts them to TypeScript type strings for the typechecker,
 * and also creates Zod schemas for runtime validation.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON Schema types (minimal subset we need)
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type?: string | string[] | undefined;
  properties?: Record<string, JsonSchema> | undefined;
  required?: string[] | undefined;
  items?: JsonSchema | undefined;
  enum?: unknown[] | undefined;
  const?: unknown;
  oneOf?: JsonSchema[] | undefined;
  anyOf?: JsonSchema[] | undefined;
  allOf?: JsonSchema[] | undefined;
  $ref?: string | undefined;
  description?: string | undefined;
  format?: string | undefined;
  additionalProperties?: boolean | JsonSchema | undefined;
}

// ---------------------------------------------------------------------------
// JSON Schema → TypeScript string
// ---------------------------------------------------------------------------

export function jsonSchemaToTypeString(schema: JsonSchema): string {
  if (!schema.type && schema.properties) {
    // Implicit object type
    return objectToTypeString(schema);
  }

  if (schema.enum) {
    return schema.enum
      .map((v) => (typeof v === "string" ? `"${v}"` : String(v)))
      .join(" | ");
  }

  if (schema.const !== undefined) {
    return typeof schema.const === "string"
      ? `"${schema.const}"`
      : String(schema.const);
  }

  if (schema.oneOf) {
    return schema.oneOf.map(jsonSchemaToTypeString).join(" | ");
  }

  if (schema.anyOf) {
    return schema.anyOf.map(jsonSchemaToTypeString).join(" | ");
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      if (schema.items) {
        return `Array<${jsonSchemaToTypeString(schema.items)}>`;
      }
      return "Array<unknown>";
    }
    case "object":
      return objectToTypeString(schema);
    default:
      return "unknown";
  }
}

function objectToTypeString(schema: JsonSchema): string {
  const props = schema.properties;
  if (!props || Object.keys(props).length === 0) {
    if (schema.additionalProperties) {
      const valueType =
        typeof schema.additionalProperties === "object"
          ? jsonSchemaToTypeString(schema.additionalProperties)
          : "unknown";
      return `Record<string, ${valueType}>`;
    }
    return "Record<string, unknown>";
  }

  const required = new Set(schema.required ?? []);
  const entries = Object.entries(props).map(([key, propSchema]) => {
    const opt = required.has(key) ? "" : "?";
    return `${key}${opt}: ${jsonSchemaToTypeString(propSchema)}`;
  });
  return `{ ${entries.join("; ")} }`;
}

// ---------------------------------------------------------------------------
// JSON Schema → Zod schema
// ---------------------------------------------------------------------------

export function jsonSchemaToZod(schema: JsonSchema): z.ZodType {
  if (!schema.type && schema.properties) {
    return objectToZod(schema);
  }

  if (schema.enum) {
    if (
      schema.enum.length > 0 &&
      schema.enum.every((v): v is string => typeof v === "string")
    ) {
      return z.enum(schema.enum as [string, ...string[]]);
    }
    return z.any();
  }

  if (schema.const !== undefined) {
    return z.literal(schema.const as string | number | boolean);
  }

  if (schema.oneOf) {
    const schemas = schema.oneOf.map(jsonSchemaToZod);
    if (schemas.length === 0) return z.any();
    if (schemas.length === 1) return schemas[0]!;
    return z.union([schemas[0]!, schemas[1]!, ...schemas.slice(2)]);
  }

  if (schema.anyOf) {
    const schemas = schema.anyOf.map(jsonSchemaToZod);
    if (schemas.length === 0) return z.any();
    if (schemas.length === 1) return schemas[0]!;
    return z.union([schemas[0]!, schemas[1]!, ...schemas.slice(2)]);
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      if (schema.items) {
        return z.array(jsonSchemaToZod(schema.items));
      }
      return z.array(z.unknown());
    }
    case "object":
      return objectToZod(schema);
    default:
      return z.any();
  }
}

function objectToZod(schema: JsonSchema): z.ZodType {
  const props = schema.properties;
  if (!props || Object.keys(props).length === 0) {
    return z.record(z.string(), z.unknown());
  }

  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodType> = {};

  for (const [key, propSchema] of Object.entries(props)) {
    const zodType = jsonSchemaToZod(propSchema);
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }

  return z.object(shape);
}
