/**
 * Convert a JSON Schema into TypeScript-like type signatures.
 *
 * Two modes:
 * - `schemaToTypeSignature(schema)` — compact single-line for badges/previews
 * - `schemaToTypeDeclaration(schema)` — multi-line with indentation for code blocks
 *
 * TODO: Ugly file, has limitations
 */

type JsonSchemaRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonSchemaRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonSchemaRecord)
    : {};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

// ---------------------------------------------------------------------------
// Compact single-line signature
// ---------------------------------------------------------------------------

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 4))} ...`;

const propertyLabel = (
  name: string,
  schema: JsonSchemaRecord,
  optional: boolean,
): string => `${name}${optional ? "?" : ""}: ${schemaToTypeSignature(schema)}`;

const compositeLabel = (
  key: "oneOf" | "anyOf" | "allOf",
  schema: JsonSchemaRecord,
): string | null => {
  const items = Array.isArray(schema[key]) ? schema[key].map(asRecord) : [];
  if (items.length === 0) return null;
  const labels = items
    .map((item) => schemaToTypeSignature(item))
    .filter((label) => label.length > 0);
  if (labels.length === 0) return null;
  return labels.join(key === "allOf" ? " & " : " | ");
};

export const schemaToTypeSignature = (
  input: unknown,
  maxLength: number = 220,
): string => {
  const schema = asRecord(input);

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref.trim();
    return ref.length > 0 ? ref.split("/").at(-1) ?? ref : "unknown";
  }
  if ("const" in schema) return JSON.stringify(schema.const);

  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  if (enumValues.length > 0) {
    return truncate(enumValues.map((v) => JSON.stringify(v)).join(" | "), maxLength);
  }

  const composite =
    compositeLabel("oneOf", schema) ??
    compositeLabel("anyOf", schema) ??
    compositeLabel("allOf", schema);
  if (composite) return truncate(composite, maxLength);

  if (schema.type === "array") {
    const itemLabel = schema.items
      ? schemaToTypeSignature(schema.items, maxLength)
      : "unknown";
    return truncate(`${itemLabel}[]`, maxLength);
  }

  if (schema.type === "object" || schema.properties) {
    const properties = asRecord(schema.properties);
    const keys = Object.keys(properties);
    if (keys.length === 0) {
      return schema.additionalProperties ? "Record<string, unknown>" : "object";
    }
    const required = new Set(asStringArray(schema.required));
    const parts = keys.map((key) =>
      propertyLabel(key, asRecord(properties[key]), !required.has(key)),
    );
    return truncate(`{ ${parts.join(", ")} }`, maxLength);
  }

  if (Array.isArray(schema.type)) return truncate(schema.type.join(" | "), maxLength);
  if (typeof schema.type === "string") return schema.type;
  return "unknown";
};

// ---------------------------------------------------------------------------
// Multi-line type declaration
// ---------------------------------------------------------------------------

const INDENT = "  ";

const refName = (ref: string): string => {
  const trimmed = ref.trim();
  return trimmed.length > 0 ? trimmed.split("/").at(-1) ?? trimmed : "unknown";
};

const compositeDecl = (
  key: "oneOf" | "anyOf" | "allOf",
  schema: JsonSchemaRecord,
  depth: number,
): string | null => {
  const items = Array.isArray(schema[key]) ? schema[key].map(asRecord) : [];
  if (items.length === 0) return null;

  const sep = key === "allOf" ? " & " : " | ";
  const parts = items.map((item) => formatNode(item, depth));
  if (parts.length === 0) return null;

  // If all parts are short primitives, inline
  const joined = parts.join(sep);
  if (joined.length < 80 && !joined.includes("\n")) return joined;

  // Multi-line
  const prefix = INDENT.repeat(depth);
  return parts.join(`\n${prefix}${sep.trim()} `);
};

const formatNode = (input: unknown, depth: number): string => {
  const schema = asRecord(input);
  const prefix = INDENT.repeat(depth);
  const innerPrefix = INDENT.repeat(depth + 1);

  // $ref
  if (typeof schema.$ref === "string") return refName(schema.$ref);

  // const
  if ("const" in schema) return JSON.stringify(schema.const);

  // enum
  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  if (enumValues.length > 0) {
    const joined = enumValues.map((v) => JSON.stringify(v)).join(" | ");
    return joined.length < 80 ? joined : enumValues.map((v) => JSON.stringify(v)).join(`\n${prefix}| `);
  }

  // composites
  const composite =
    compositeDecl("oneOf", schema, depth) ??
    compositeDecl("anyOf", schema, depth) ??
    compositeDecl("allOf", schema, depth);
  if (composite) return composite;

  // array
  if (schema.type === "array") {
    const itemType = schema.items ? formatNode(schema.items, depth) : "unknown";
    if (itemType.includes("\n")) {
      return `Array<\n${innerPrefix}${itemType}\n${prefix}>`;
    }
    return `${itemType}[]`;
  }

  // object
  if (schema.type === "object" || schema.properties) {
    const properties = asRecord(schema.properties);
    const keys = Object.keys(properties);

    if (keys.length === 0) {
      return schema.additionalProperties ? "Record<string, unknown>" : "{}";
    }

    const required = new Set(asStringArray(schema.required));
    const lines = keys.map((key) => {
      const propSchema = asRecord(properties[key]);
      const opt = required.has(key) ? "" : "?";
      const typeStr = formatNode(propSchema, depth + 1);

      // Add description as comment if present
      const desc = typeof propSchema.description === "string" ? propSchema.description : null;
      const comment = desc ? `${innerPrefix}/** ${desc} */\n` : "";

      if (typeStr.includes("\n")) {
        return `${comment}${innerPrefix}${key}${opt}: ${typeStr};`;
      }
      return `${comment}${innerPrefix}${key}${opt}: ${typeStr};`;
    });

    return `{\n${lines.join("\n")}\n${prefix}}`;
  }

  // union type array
  if (Array.isArray(schema.type)) return schema.type.join(" | ");

  // primitive
  if (typeof schema.type === "string") {
    switch (schema.type) {
      case "string": return "string";
      case "number": case "integer": return "number";
      case "boolean": return "boolean";
      case "null": return "null";
      default: return schema.type;
    }
  }

  return "unknown";
};

/**
 * Convert a JSON Schema to a multi-line TypeScript-like type declaration.
 * Suitable for rendering in a code block with syntax highlighting.
 */
export const schemaToTypeDeclaration = (
  input: unknown,
  name?: string,
): string => {
  const body = formatNode(input, 0);
  if (name) {
    return `type ${name} = ${body}`;
  }
  return body;
};
