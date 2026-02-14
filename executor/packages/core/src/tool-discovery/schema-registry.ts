import type { ToolDefinition } from "../types";
import type { DiscoverIndexEntry } from "./types";

function skipWhitespaceAndComments(input: string, start: number): number {
  let index = start;

  while (index < input.length) {
    const char = input[index];
    const next = input[index + 1];

    if (char && /\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < input.length) {
        if (input[index] === "*" && input[index + 1] === "/") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    break;
  }

  return index;
}

function findMatchingBrace(input: string, openIndex: number): number {
  let depth = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openIndex; index < input.length; index += 1) {
    const char = input[index]!;
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function extractInterfaceBody(dts: string, interfaceName: string): string {
  const pattern = new RegExp(`\\b(?:export\\s+)?interface\\s+${interfaceName}\\s*\\{`, "g");
  const match = pattern.exec(dts);
  if (!match) return "";

  const openIndex = dts.indexOf("{", match.index);
  if (openIndex === -1) return "";

  const closeIndex = findMatchingBrace(dts, openIndex);
  if (closeIndex === -1) return "";

  return dts.slice(openIndex + 1, closeIndex);
}

function extractNestedObjectBody(input: string, key: string): string {
  const pattern = new RegExp(`\\b${key}\\??\\s*:\\s*\\{`, "g");
  const match = pattern.exec(input);
  if (!match) return "";

  const openIndex = input.indexOf("{", match.index);
  if (openIndex === -1) return "";

  const closeIndex = findMatchingBrace(input, openIndex);
  if (closeIndex === -1) return "";

  return input.slice(openIndex + 1, closeIndex);
}

function parseStringLiteral(raw: string): string {
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }

  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/\\'/g, "'");
  }

  return raw;
}

function readQuotedToken(input: string, start: number): { value: string; next: number } | null {
  const quote = input[start];
  if (quote !== "\"" && quote !== "'") return null;

  let index = start + 1;
  while (index < input.length) {
    const char = input[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      const raw = input.slice(start, index + 1);
      return { value: parseStringLiteral(raw), next: index + 1 };
    }
    index += 1;
  }

  return null;
}

function readIdentifierToken(input: string, start: number): { value: string; next: number } | null {
  const first = input[start];
  if (!first || !/[A-Za-z_$]/.test(first)) return null;

  let index = start + 1;
  while (index < input.length && /[A-Za-z0-9_$]/.test(input[index]!)) {
    index += 1;
  }

  return { value: input.slice(start, index), next: index };
}

function readTypeExpression(input: string, start: number): { expression: string; next: number } {
  let index = start;
  let depthCurly = 0;
  let depthSquare = 0;
  let depthParen = 0;
  let depthAngle = 0;
  let quote: "\"" | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (index < input.length) {
    const char = input[index]!;
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      index += 1;
      continue;
    }

    if (char === "{") depthCurly += 1;
    else if (char === "}") depthCurly = Math.max(0, depthCurly - 1);
    else if (char === "[") depthSquare += 1;
    else if (char === "]") depthSquare = Math.max(0, depthSquare - 1);
    else if (char === "(") depthParen += 1;
    else if (char === ")") depthParen = Math.max(0, depthParen - 1);
    else if (char === "<") depthAngle += 1;
    else if (char === ">") depthAngle = Math.max(0, depthAngle - 1);
    else if (
      char === ";"
      && depthCurly === 0
      && depthSquare === 0
      && depthParen === 0
      && depthAngle === 0
    ) {
      break;
    }

    index += 1;
  }

  return {
    expression: input.slice(start, index).trim(),
    next: index,
  };
}

function parseSchemaTypeMap(schemasBlock: string): Record<string, string> {
  const map: Record<string, string> = {};
  let index = 0;

  while (index < schemasBlock.length) {
    index = skipWhitespaceAndComments(schemasBlock, index);
    if (index >= schemasBlock.length) break;

    const char = schemasBlock[index];
    if (!char) break;

    if (char === ";" || char === ",") {
      index += 1;
      continue;
    }

    if (char === "[") {
      while (index < schemasBlock.length && schemasBlock[index] !== ";") {
        index += 1;
      }
      if (schemasBlock[index] === ";") index += 1;
      continue;
    }

    const keyToken = readQuotedToken(schemasBlock, index) ?? readIdentifierToken(schemasBlock, index);
    if (!keyToken) {
      index += 1;
      continue;
    }

    const key = keyToken.value.trim();
    index = skipWhitespaceAndComments(schemasBlock, keyToken.next);
    if (schemasBlock[index] === "?") {
      index = skipWhitespaceAndComments(schemasBlock, index + 1);
    }

    if (schemasBlock[index] !== ":") {
      index += 1;
      continue;
    }

    index = skipWhitespaceAndComments(schemasBlock, index + 1);
    const { expression, next } = readTypeExpression(schemasBlock, index);
    if (expression) {
      map[key] = expression;
    }

    index = next;
    if (schemasBlock[index] === ";" || schemasBlock[index] === ",") {
      index += 1;
    }
  }

  return map;
}

export function extractSchemaRefKeys(typeExpression: string): string[] {
  const refs = new Set<string>();
  const pattern = /components\["schemas"\]\["((?:\\.|[^"\\])*)"\]/g;

  for (const match of typeExpression.matchAll(pattern)) {
    const raw = match[1];
    if (!raw) continue;

    let key = raw;
    try {
      key = JSON.parse(`"${raw}"`);
    } catch {
      // Keep original escaped key if decode fails.
    }

    refs.add(key);
  }

  return [...refs];
}

function formatSchemaRefToken(schemaKey: string): string {
  return `components["schemas"][${JSON.stringify(schemaKey)}]`;
}

export function extractSourceSchemaTypesFromDts(dts: string): Record<string, string> {
  const componentsBody = extractInterfaceBody(dts, "components");
  if (!componentsBody) return {};

  const schemasBody = extractNestedObjectBody(componentsBody, "schemas");
  if (!schemasBody) return {};

  return parseSchemaTypeMap(schemasBody);
}

export function buildSourceSchemaTypeMap(tools: ToolDefinition[]): Record<string, Record<string, string>> {
  const sourceDtsBySource: Record<string, string> = {};

  for (const tool of tools) {
    if (!tool.source || sourceDtsBySource[tool.source]) continue;
    const dts = tool.metadata?.sourceDts?.trim();
    if (dts) {
      sourceDtsBySource[tool.source] = dts;
    }
  }

  const bySource: Record<string, Record<string, string>> = {};

  for (const [source, dts] of Object.entries(sourceDtsBySource)) {
    const schemaMap = extractSourceSchemaTypesFromDts(dts);
    if (Object.keys(schemaMap).length > 0) {
      bySource[source] = schemaMap;
    }
  }

  return bySource;
}

export function buildSchemaRegistryForEntries(
  entries: DiscoverIndexEntry[],
  sourceSchemaTypes: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const registry: Record<string, Record<string, string>> = {};

  for (const entry of entries) {
    const sourceSchemas = sourceSchemaTypes[entry.source];
    if (!sourceSchemas) continue;

    const refKeys = new Set<string>([
      ...extractSchemaRefKeys(entry.argsType),
      ...extractSchemaRefKeys(entry.returnsType),
    ]);

    if (refKeys.size === 0) continue;

    const sourceRegistry = registry[entry.source] ?? {};
    for (const key of refKeys) {
      const schemaType = sourceSchemas[key];
      if (!schemaType) continue;
      sourceRegistry[formatSchemaRefToken(key)] = schemaType;
    }

    if (Object.keys(sourceRegistry).length > 0) {
      registry[entry.source] = sourceRegistry;
    }
  }

  return registry;
}
