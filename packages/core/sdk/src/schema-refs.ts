// ---------------------------------------------------------------------------
// JSON Schema $ref hoisting and re-attachment
//
// Core logic for deduplicating shared definitions across tools.
// Used by any ToolRegistry implementation (in-memory, database-backed, etc.)
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

/**
 * Extract `$defs`, `definitions`, and `components.schemas` from a JSON Schema,
 * returning { stripped, defs } where `stripped` is the schema without local
 * definitions and `defs` is a flat map of definition name → schema.
 */
export const hoistDefinitions = (
  schema: unknown,
): { stripped: unknown; defs: Record<string, unknown> } => {
  if (schema == null || typeof schema !== "object") {
    return { stripped: schema, defs: {} };
  }
  const obj = schema as JsonObj;
  const defs: Record<string, unknown> = {};

  // $defs (JSON Schema draft 2019+, Effect)
  if (obj.$defs && typeof obj.$defs === "object") {
    for (const [k, v] of Object.entries(obj.$defs as JsonObj)) {
      defs[k] = v;
    }
  }

  // definitions (JSON Schema draft-07)
  if (obj.definitions && typeof obj.definitions === "object") {
    for (const [k, v] of Object.entries(obj.definitions as JsonObj)) {
      defs[k] = v;
    }
  }

  // components.schemas (OpenAPI)
  const components = obj.components as JsonObj | undefined;
  if (components?.schemas && typeof components.schemas === "object") {
    for (const [k, v] of Object.entries(components.schemas as JsonObj)) {
      defs[k] = v;
    }
  }

  // Build stripped schema without the definition containers
  const { $defs: _a, definitions: _b, components: _c, ...rest } = obj;
  // If components had other keys besides schemas, preserve them
  if (components && typeof components === "object") {
    const { schemas: _s, ...otherComponents } = components;
    if (Object.keys(otherComponents).length > 0) {
      (rest as JsonObj).components = otherComponents;
    }
  }

  return { stripped: rest, defs };
};

/**
 * Walk a schema and collect all $ref target names transitively.
 * e.g. "#/$defs/Address" → "Address", and if Address references City, both.
 */
export const collectRefs = (
  node: unknown,
  defs: ReadonlyMap<string, unknown>,
  found: Set<string> = new Set(),
): Set<string> => {
  if (node == null || typeof node !== "object") return found;
  const obj = node as JsonObj;

  if (typeof obj.$ref === "string") {
    const name = parseRefName(obj.$ref);
    if (name && !found.has(name)) {
      found.add(name);
      const def = defs.get(name);
      if (def) collectRefs(def, defs, found);
    }
    return found;
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      if (Array.isArray(v)) {
        for (const item of v) collectRefs(item, defs, found);
      } else {
        collectRefs(v, defs, found);
      }
    }
  }
  return found;
};

/**
 * Re-attach only the referenced shared definitions into a schema,
 * so the caller gets a self-contained, usable JSON Schema.
 */
export const reattachDefs = (
  schema: unknown,
  defs: ReadonlyMap<string, unknown>,
): unknown => {
  if (schema == null || typeof schema !== "object") return schema;
  const refs = collectRefs(schema, defs);
  if (refs.size === 0) return schema;

  const attached: Record<string, unknown> = {};
  for (const name of refs) {
    const def = defs.get(name);
    if (def) attached[name] = def;
  }

  return { ...(schema as JsonObj), $defs: attached };
};

/** Extract the definition name from a $ref pointer */
const parseRefName = (ref: string): string | undefined => {
  const match = ref.match(
    /^#\/(?:\$defs|definitions|components\/schemas)\/(.+)$/,
  );
  return match?.[1];
};
