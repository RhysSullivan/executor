type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const parseRefHintTableJson = (
  refHintTableJson: string | null | undefined,
): Record<string, string> | null => {
  if (!refHintTableJson) return null;
  const parsed = parseJson(refHintTableJson);
  if (!isJsonObject(parsed)) return null;

  const table: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      table[key] = value;
    }
  }
  return table;
};

const resolveSchemaNode = (
  value: unknown,
  refHintTable: Readonly<Record<string, string>>,
  parsedHintCache: Map<string, unknown>,
  activeRefs: ReadonlySet<string>,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) =>
      resolveSchemaNode(item, refHintTable, parsedHintCache, activeRefs),
    );
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const ref = typeof value.$ref === "string" ? value.$ref : null;
  if (ref && ref.startsWith("#/") && !activeRefs.has(ref)) {
    let resolvedRefValue = parsedHintCache.get(ref);

    if (resolvedRefValue === undefined) {
      const rawHint = refHintTable[ref];
      resolvedRefValue = typeof rawHint === "string" ? parseJson(rawHint) : null;
      parsedHintCache.set(ref, resolvedRefValue);
    }

    if (resolvedRefValue !== null && resolvedRefValue !== undefined) {
      const nextActiveRefs = new Set(activeRefs);
      nextActiveRefs.add(ref);

      const { $ref: _ignoredRef, ...rest } = value;
      const resolvedTarget = resolveSchemaNode(
        resolvedRefValue,
        refHintTable,
        parsedHintCache,
        nextActiveRefs,
      );

      if (Object.keys(rest).length === 0) {
        return resolvedTarget;
      }

      const resolvedRest = resolveSchemaNode(
        rest,
        refHintTable,
        parsedHintCache,
        activeRefs,
      );

      if (isJsonObject(resolvedTarget) && isJsonObject(resolvedRest)) {
        return { ...resolvedTarget, ...resolvedRest };
      }

      return resolvedTarget;
    }
  }

  const next: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    next[key] = resolveSchemaNode(
      nestedValue,
      refHintTable,
      parsedHintCache,
      activeRefs,
    );
  }

  return next;
};

export const resolveSchemaJsonWithRefHints = (
  schemaJson: string | null,
  refHintTableJson: string | null | undefined,
): string | null => {
  if (!schemaJson) {
    return null;
  }

  const parsedSchema = parseJson(schemaJson);
  if (parsedSchema === null) {
    return schemaJson;
  }

  const refHintTable = parseRefHintTableJson(refHintTableJson);
  if (!refHintTable || Object.keys(refHintTable).length === 0) {
    return schemaJson;
  }

  const resolved = resolveSchemaNode(
    parsedSchema,
    refHintTable,
    new Map<string, unknown>(),
    new Set<string>(),
  );

  try {
    return JSON.stringify(resolved);
  } catch {
    return schemaJson;
  }
};
