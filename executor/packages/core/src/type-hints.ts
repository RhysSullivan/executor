function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(16, maxLength - 3)).trim()}...`;
}

function splitTopLevelBy(value: string, separator: string): string[] {
  const parts: string[] = [];
  let segment = "";
  let depthCurly = 0;
  let depthSquare = 0;
  let depthParen = 0;
  let depthAngle = 0;

  for (const char of value) {
    if (char === "{") depthCurly += 1;
    else if (char === "}") depthCurly = Math.max(0, depthCurly - 1);
    else if (char === "[") depthSquare += 1;
    else if (char === "]") depthSquare = Math.max(0, depthSquare - 1);
    else if (char === "(") depthParen += 1;
    else if (char === ")") depthParen = Math.max(0, depthParen - 1);
    else if (char === "<") depthAngle += 1;
    else if (char === ">") depthAngle = Math.max(0, depthAngle - 1);

    if (
      char === separator
      && depthCurly === 0
      && depthSquare === 0
      && depthParen === 0
      && depthAngle === 0
    ) {
      const trimmed = segment.trim();
      if (trimmed.length > 0) parts.push(trimmed);
      segment = "";
      continue;
    }

    segment += char;
  }

  const trimmed = segment.trim();
  if (trimmed.length > 0) parts.push(trimmed);
  return parts;
}

function normalizeSimpleUnion(typeExpression: string): string {
  const parts = splitTopLevelBy(typeExpression, "|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2) return typeExpression;
  if (parts.some((part) => /[{};]/.test(part))) return typeExpression;

  const unique: string[] = [];
  for (const part of parts) {
    if (!unique.includes(part)) unique.push(part);
  }

  if (unique.length === parts.length) return typeExpression;
  return unique.join(" | ");
}

function normalizeFlatObjectHint(typeHint: string): string | null {
  const trimmed = typeHint.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  const inner = trimmed.slice(1, -1);
  const segments = splitTopLevelBy(inner, ";");
  if (segments.length === 0) return null;

  const normalizedSegments: string[] = [];
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment) continue;

    const colonIndex = segment.indexOf(":");
    if (colonIndex <= 0) {
      normalizedSegments.push(segment);
      continue;
    }

    const key = segment.slice(0, colonIndex).trim();
    const value = normalizeSimpleUnion(segment.slice(colonIndex + 1).trim());
    normalizedSegments.push(`${key}: ${value}`);
  }

  if (normalizedSegments.length === 0) return null;
  return `{ ${normalizedSegments.join("; ")} }`;
}

function normalizeIntersectionObjectHint(
  typeHint: string,
  options: { maxParts?: number; maxKeys?: number; maxLength?: number } = {},
): string | null {
  const maxParts = options.maxParts ?? 6;
  const maxKeys = options.maxKeys ?? 8;
  const maxLength = options.maxLength ?? 140;
  const parts = splitTopLevelBy(typeHint, "&");
  if (parts.length < 2 || parts.length > maxParts) return null;

  const orderedKeys: string[] = [];
  const keyToType = new Map<string, string>();

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

    const inner = trimmed.slice(1, -1);
    const segments = splitTopLevelBy(inner, ";");
    for (const rawSegment of segments) {
      const segment = rawSegment.trim();
      if (!segment || segment.startsWith("[")) continue;
      const colonIndex = segment.indexOf(":");
      if (colonIndex <= 0) continue;

      const key = segment.slice(0, colonIndex).trim().replace(/["']/g, "");
      if (!key) continue;
      const value = normalizeSimpleUnion(segment.slice(colonIndex + 1).trim());
      if (!value) continue;

      if (!keyToType.has(key)) {
        orderedKeys.push(key);
        keyToType.set(key, value);
      }
    }
  }

  if (orderedKeys.length === 0 || orderedKeys.length > maxKeys) return null;

  const entries = orderedKeys.map((key) => `${key}: ${keyToType.get(key)}`);
  const compact = `{ ${entries.join("; ")} }`;
  if (compact.length > maxLength) return null;
  return compact;
}

export function extractTopLevelTypeKeys(typeHint: string): string[] {
  const text = typeHint.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return [];

  const inner = text.slice(1, -1);
  const keys: string[] = [];
  let segment = "";
  let depthCurly = 0;
  let depthSquare = 0;
  let depthParen = 0;
  let depthAngle = 0;

  const flushSegment = () => {
    const part = segment.trim();
    segment = "";
    if (!part) return;
    const colon = part.indexOf(":");
    if (colon <= 0) return;
    const rawKey = part.slice(0, colon).trim();
    const cleanedKey = rawKey.replace(/[?"']/g, "").trim();
    if (!cleanedKey || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cleanedKey)) return;
    if (!keys.includes(cleanedKey)) keys.push(cleanedKey);
  };

  for (const char of inner) {
    if (char === "{") depthCurly += 1;
    else if (char === "}") depthCurly = Math.max(0, depthCurly - 1);
    else if (char === "[") depthSquare += 1;
    else if (char === "]") depthSquare = Math.max(0, depthSquare - 1);
    else if (char === "(") depthParen += 1;
    else if (char === ")") depthParen = Math.max(0, depthParen - 1);
    else if (char === "<") depthAngle += 1;
    else if (char === ">") depthAngle = Math.max(0, depthAngle - 1);

    if (char === ";" && depthCurly === 0 && depthSquare === 0 && depthParen === 0 && depthAngle === 0) {
      flushSegment();
      continue;
    }

    segment += char;
  }

  flushSegment();
  return keys;
}

export function compactArgKeysHint(keys: string[]): string {
  const normalized = keys
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  if (normalized.length === 0) return "{}";

  const unique: string[] = [];
  for (const key of normalized) {
    if (!unique.includes(key)) unique.push(key);
  }

  const maxKeys = 6;
  const shown = unique.slice(0, maxKeys).map((key) => `${key}: ...`);
  const suffix = unique.length > maxKeys ? "; ..." : "";
  return `{ ${shown.join("; ")}${suffix} }`;
}

export function compactArgTypeHint(argsType: string): string {
  if (argsType === "{}") return "{}";
  const normalized = argsType.replace(/\s+/g, " ").trim();

  const flattenedIntersection = normalizeIntersectionObjectHint(normalized, { maxLength: 160 });
  if (flattenedIntersection) {
    return flattenedIntersection;
  }

  const inlineFriendlyObject = normalized.startsWith("{")
    && normalized.endsWith("}")
    && normalized.length <= 100
    && !normalized.includes("&");
  if (inlineFriendlyObject) {
    return normalizeFlatObjectHint(normalized) ?? normalized;
  }

  const inlineObjectWithSimpleUnions = normalized.startsWith("{")
    && normalized.endsWith("}")
    && normalized.length <= 220
    && !normalized.includes("&")
    && !normalized.slice(1, -1).includes("{")
    && !normalized.slice(1, -1).includes("}");
  if (inlineObjectWithSimpleUnions) {
    return normalizeFlatObjectHint(normalized) ?? normalized;
  }
  const keys = extractTopLevelTypeKeys(argsType);
  if (keys.length > 0) {
    return compactArgKeysHint(keys);
  }
  return truncateInline(argsType, 120);
}

export function compactArgDisplayHint(argsType: string, argPreviewKeys: string[] = []): string {
  const compactFromType = compactArgTypeHint(argsType);
  if (compactFromType !== "{}" && compactFromType.includes(":")) {
    const normalized = compactFromType.replace(/\s+/g, " ").trim();
    if (!normalized.includes("...")) {
      return compactFromType;
    }
  }

  if (argPreviewKeys.length > 0) {
    return compactArgKeysHint(argPreviewKeys);
  }

  return compactFromType;
}

export function compactReturnTypeHint(returnsType: string): string {
  const normalized = returnsType.replace(/\s+/g, " ").trim();
  if (normalized.startsWith("{ data:") && normalized.includes("errors:")) {
    return "{ data: ...; errors: unknown[] }";
  }
  const flattenedIntersection = normalizeIntersectionObjectHint(normalized, {
    maxParts: 6,
    maxKeys: 16,
    maxLength: 520,
  });
  if (flattenedIntersection) {
    return flattenedIntersection;
  }
  const inlineFriendlyObject = normalized.startsWith("{")
    && normalized.endsWith("}")
    && normalized.length <= 520
    && !normalized.includes("|")
    && !normalized.includes("&");
  if (inlineFriendlyObject) {
    return normalized;
  }
  if (normalized.endsWith("[]") && normalized.length > 90) {
    return "Array<...>";
  }
  return truncateInline(normalized, 130);
}

export function compactDescriptionLine(description: string): string {
  const firstLine = description.split("\n")[0] ?? description;
  return truncateInline(firstLine, 180);
}
