/**
 * schema-traverse.ts
 *
 * Structured JSON Schema walker using json-schema-traverse.
 * Produces a flat list of documented field entries for rendering,
 * handling properties, items, oneOf/anyOf/allOf, enums, and nested objects.
 */

import traverse from "json-schema-traverse";

// ── Types ────────────────────────────────────────────────────────────────────

export type SchemaFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "null"
  | "enum"
  | "union"
  | "unknown";

export interface SchemaFieldEntry {
  /** Dot-delimited path, e.g. "config.retries" */
  path: string;
  /** Resolved JSON Schema type */
  type: SchemaFieldType;
  /** Human-readable type label (e.g. "string[]", "string | number") */
  typeLabel: string;
  /** Whether this field is required by its parent */
  required: boolean;
  /** Description from the schema */
  description?: string;
  /** Example value (serialized) */
  example?: string;
  /** Default value (serialized) */
  defaultValue?: string;
  /** Whether the field is marked deprecated */
  deprecated: boolean;
  /** Enum values if present */
  enumValues?: string[];
  /** Format hint (e.g. "uri", "date-time", "email") */
  format?: string;
  /** Nesting depth (0 = top-level) */
  depth: number;
  /** If array, the item type label */
  itemType?: string;
  /** Constraints: minimum, maximum, minLength, maxLength, pattern */
  constraints?: SchemaConstraints;
}

export interface SchemaConstraints {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface TraverseOptions {
  maxDepth?: number;
  maxEntries?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function toPreview(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") {
    const t = v.trim();
    return t ? (t.length > 120 ? `${t.slice(0, 120)}...` : t) : undefined;
  }
  try {
    const s = JSON.stringify(v);
    return s && s.length > 0
      ? s.length > 120
        ? `${s.slice(0, 120)}...`
        : s
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveTypeLabel(schema: Record<string, unknown>): {
  type: SchemaFieldType;
  label: string;
  itemType?: string;
} {
  // Enum
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return { type: "enum", label: schema.enum.map((v) => JSON.stringify(v)).join(" | ") };
  }

  // Const
  if (schema.const !== undefined) {
    return { type: "enum", label: JSON.stringify(schema.const) };
  }

  // oneOf / anyOf union
  const union = (schema.oneOf ?? schema.anyOf) as unknown[] | undefined;
  if (Array.isArray(union) && union.length > 0) {
    const parts = union.map((s) => {
      const sub = asRecord(s);
      return resolveTypeLabel(sub).label;
    });
    return { type: "union", label: parts.join(" | ") };
  }

  // allOf intersection
  const allOf = schema.allOf as unknown[] | undefined;
  if (Array.isArray(allOf) && allOf.length > 0) {
    const parts = allOf.map((s) => {
      const sub = asRecord(s);
      return resolveTypeLabel(sub).label;
    });
    return { type: "object", label: parts.join(" & ") };
  }

  // Type array (e.g. ["string", "null"])
  if (Array.isArray(schema.type)) {
    const types = schema.type as string[];
    if (types.length === 2 && types.includes("null")) {
      const nonNull = types.find((t) => t !== "null") ?? "unknown";
      return { type: nonNull as SchemaFieldType, label: `${nonNull} | null` };
    }
    return { type: "union", label: types.join(" | ") };
  }

  const rawType = typeof schema.type === "string" ? schema.type : undefined;

  // Array with items
  if (rawType === "array") {
    const items = asRecord(schema.items);
    if (Object.keys(items).length > 0) {
      const inner = resolveTypeLabel(items);
      return { type: "array", label: `${inner.label}[]`, itemType: inner.label };
    }
    return { type: "array", label: "array", itemType: undefined };
  }

  // Object
  if (rawType === "object") {
    return { type: "object", label: "object" };
  }

  // String with format
  if (rawType === "string" && typeof schema.format === "string") {
    return { type: "string", label: `string<${schema.format}>` };
  }

  // Simple type
  if (rawType) {
    return { type: rawType as SchemaFieldType, label: rawType };
  }

  return { type: "unknown", label: "unknown" };
}

function extractConstraints(schema: Record<string, unknown>): SchemaConstraints | undefined {
  const c: SchemaConstraints = {};
  let hasAny = false;

  for (const [key, field] of [
    ["minimum", "minimum"],
    ["maximum", "maximum"],
    ["exclusiveMinimum", "exclusiveMinimum"],
    ["exclusiveMaximum", "exclusiveMaximum"],
    ["minLength", "minLength"],
    ["maxLength", "maxLength"],
    ["minItems", "minItems"],
    ["maxItems", "maxItems"],
  ] as const) {
    if (typeof schema[field] === "number") {
      (c as Record<string, unknown>)[key] = schema[field];
      hasAny = true;
    }
  }

  if (typeof schema.pattern === "string") {
    c.pattern = schema.pattern;
    hasAny = true;
  }
  if (schema.uniqueItems === true) {
    c.uniqueItems = true;
    hasAny = true;
  }

  return hasAny ? c : undefined;
}

// ── Main traversal ──────────────────────────────────────────────────────────

export function traverseSchema(
  schema: Record<string, unknown>,
  options: TraverseOptions = {},
): { entries: SchemaFieldEntry[]; truncated: boolean } {
  const maxDepth = options.maxDepth ?? 5;
  const maxEntries = options.maxEntries ?? 40;
  const entries: SchemaFieldEntry[] = [];
  let truncated = false;

  // Use json-schema-traverse to walk all sub-schemas
  // We track the JSON pointer path to compute our dot-notation path
  const requiredSets = new Map<string, Set<string>>();

  // Pre-compute required sets for all object nodes
  traverse(schema, {
    cb: (subSchema, jsonPtr) => {
      const node = asRecord(subSchema);
      if (Array.isArray(node.required)) {
        const ptr = jsonPtr || "";
        requiredSets.set(
          ptr,
          new Set(
            (node.required as unknown[]).filter((v): v is string => typeof v === "string"),
          ),
        );
      }
    },
  });

  // Now do a targeted walk ourselves for rendering, using json-schema-traverse
  // for validation but our own recursive walk for the rendering entries.
  // This gives us more control over depth, path naming, and entry construction.

  const walk = (
    node: unknown,
    prefix: string,
    depth: number,
    parentRequiredKeys: Set<string>,
  ) => {
    if (depth > maxDepth || truncated) return;
    const shape = asRecord(node);

    // Collect required set for this node
    const requiredKeys = new Set(
      Array.isArray(shape.required)
        ? (shape.required as unknown[]).filter((v): v is string => typeof v === "string")
        : [],
    );

    // Walk properties
    const properties = asRecord(shape.properties);
    for (const [rawKey, child] of Object.entries(properties)) {
      if (truncated) break;
      const key = rawKey.trim();
      if (!key) continue;

      const childShape = asRecord(child);
      const path = prefix ? `${prefix}.${key}` : key;
      const { type, label, itemType } = resolveTypeLabel(childShape);
      const description =
        typeof childShape.description === "string"
          ? childShape.description.trim() || undefined
          : undefined;
      const example = toPreview(childShape.example);
      const defaultValue = toPreview(childShape.default);
      const deprecated = childShape.deprecated === true;
      const isRequired = parentRequiredKeys.has(key) || requiredKeys.has(key);
      const format =
        typeof childShape.format === "string" ? childShape.format : undefined;
      const enumValues = Array.isArray(childShape.enum)
        ? (childShape.enum as unknown[]).map((v) => JSON.stringify(v))
        : undefined;
      const constraints = extractConstraints(childShape);

      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }

      entries.push({
        path,
        type,
        typeLabel: label,
        required: isRequired,
        description,
        example,
        defaultValue,
        deprecated,
        enumValues,
        format,
        depth,
        itemType,
        constraints,
      });

      // Recurse into nested objects
      if (type === "object" || asRecord(childShape.properties) && Object.keys(asRecord(childShape.properties)).length > 0) {
        walk(childShape, path, depth + 1, requiredKeys);
      }

      // Recurse into array items if they have properties
      if (type === "array" && childShape.items) {
        const itemShape = asRecord(childShape.items);
        if (Object.keys(asRecord(itemShape.properties)).length > 0) {
          walk(itemShape, `${path}[]`, depth + 1, new Set<string>());
        }
      }

      // Recurse into oneOf/anyOf variants that have properties
      const variants = (childShape.oneOf ?? childShape.anyOf) as unknown[] | undefined;
      if (Array.isArray(variants)) {
        for (const variant of variants) {
          const variantShape = asRecord(variant);
          if (Object.keys(asRecord(variantShape.properties)).length > 0) {
            walk(variantShape, path, depth + 1, new Set<string>());
          }
        }
      }
    }

    // Handle top-level oneOf/anyOf/allOf at any node if there are no direct properties
    if (Object.keys(properties).length === 0) {
      const composites = [
        ...(Array.isArray(shape.oneOf) ? (shape.oneOf as unknown[]) : []),
        ...(Array.isArray(shape.anyOf) ? (shape.anyOf as unknown[]) : []),
        ...(Array.isArray(shape.allOf) ? (shape.allOf as unknown[]) : []),
      ];
      for (const comp of composites) {
        walk(comp, prefix, depth, parentRequiredKeys);
      }
    }
  };

  walk(schema, "", 0, new Set<string>());

  // Preserve schema traversal order so parent/child fields stay grouped.
  return { entries, truncated };
}

/**
 * Summarize a JSON Schema into a brief one-line type signature.
 * e.g. "{ name: string, age?: number, tags: string[] }"
 */
export function schemaToTypeHint(schema: Record<string, unknown>, maxLength = 120): string {
  const properties = asRecord(schema.properties);
  const requiredKeys = new Set(
    Array.isArray(schema.required)
      ? (schema.required as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
  );

  const keys = Object.keys(properties);
  if (keys.length === 0) {
    const { label } = resolveTypeLabel(schema);
    return label;
  }

  const parts: string[] = [];
  for (const key of keys) {
    const childShape = asRecord(properties[key]);
    const { label } = resolveTypeLabel(childShape);
    const optional = requiredKeys.has(key) ? "" : "?";
    parts.push(`${key}${optional}: ${label}`);
  }

  const joined = `{ ${parts.join(", ")} }`;
  if (joined.length <= maxLength) return joined;

  // Truncate to fit
  let result = "{ ";
  for (let i = 0; i < parts.length; i++) {
    const next = result + parts[i] + (i < parts.length - 1 ? ", " : " }");
    if (next.length > maxLength - 6) {
      return `${result}... }`;
    }
    result = i < parts.length - 1 ? result + parts[i] + ", " : next;
  }
  return result;
}
