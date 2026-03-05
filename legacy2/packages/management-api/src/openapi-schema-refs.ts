type JsonObject = Record<string, unknown>;

type DiscoveryTypingLike = {
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  refHintKeys?: ReadonlyArray<string>;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const resolveSchemaNode = (
  value: unknown,
  refHintTable: Readonly<Record<string, string>>,
  parsedHintCache: Map<string, unknown>,
  activeRefs: ReadonlySet<string>,
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) =>
      resolveSchemaNode(item, refHintTable, parsedHintCache, activeRefs)
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
  schemaJson: string | undefined,
  refHintTable: Readonly<Record<string, string>> | undefined,
): string | null => {
  if (!schemaJson) {
    return null;
  }

  const parsedSchema = parseJson(schemaJson);
  if (parsedSchema === null) {
    return schemaJson;
  }

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

export const resolveTypingSchemasWithRefHints = (
  typing: DiscoveryTypingLike | undefined,
  refHintTable: Readonly<Record<string, string>> | undefined,
): {
  inputSchemaJson: string | null;
  outputSchemaJson: string | null;
} => ({
  inputSchemaJson: resolveSchemaJsonWithRefHints(
    typing?.inputSchemaJson,
    refHintTable,
  ),
  outputSchemaJson: resolveSchemaJsonWithRefHints(
    typing?.outputSchemaJson,
    refHintTable,
  ),
});
