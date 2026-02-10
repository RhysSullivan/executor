function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(16, maxLength - 3)).trim()}...`;
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

export function compactArgTypeHint(argsType: string): string {
  if (argsType === "{}") return "{}";
  const keys = extractTopLevelTypeKeys(argsType);
  if (keys.length > 0) {
    const maxKeys = 4;
    const shown = keys.slice(0, maxKeys).map((key) => `${key}: ...`);
    const suffix = keys.length > maxKeys ? "; ..." : "";
    return `{ ${shown.join("; ")}${suffix} }`;
  }
  return truncateInline(argsType, 120);
}

export function compactReturnTypeHint(returnsType: string): string {
  const normalized = returnsType.replace(/\s+/g, " ").trim();
  if (normalized.startsWith("{ data:") && normalized.includes("errors:")) {
    return "{ data: ...; errors: unknown[] }";
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
