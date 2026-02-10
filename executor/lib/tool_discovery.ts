import type { ToolDefinition } from "./types";

interface DiscoverIndexEntry {
  path: string;
  aliases: string[];
  description: string;
  approval: ToolDefinition["approval"];
  source: string;
  argsType: string;
  returnsType: string;
  searchText: string;
  normalizedPath: string;
  normalizedSearchText: string;
}

function normalizeType(type?: string): string {
  return type && type.trim().length > 0 ? type : "unknown";
}

function normalizeSearchToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toCamelSegment(segment: string): string {
  return segment.replace(/_+([a-z0-9])/g, (_m, char: string) => char.toUpperCase());
}

function getPathAliases(path: string): string[] {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return [];

  const aliases = new Set<string>();
  const camelPath = segments.map(toCamelSegment).join(".");
  const compactPath = segments.map((segment) => segment.replace(/[_-]/g, "")).join(".");
  const lowerPath = path.toLowerCase();

  if (camelPath !== path) aliases.add(camelPath);
  if (compactPath !== path) aliases.add(compactPath);
  if (lowerPath !== path) aliases.add(lowerPath);

  return [...aliases].slice(0, 4);
}

function extractTopLevelArgKeys(argsType: string): string[] {
  const text = argsType.trim();
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
    if (char === "{" ) depthCurly += 1;
    else if (char === "}" ) depthCurly = Math.max(0, depthCurly - 1);
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

function buildExampleCall(entry: DiscoverIndexEntry): string {
  if (entry.path.endsWith(".graphql")) {
    return `await tools.${entry.path}({ query: "query { __typename }", variables: {} });`;
  }

  if (entry.argsType === "{}") {
    return `await tools.${entry.path}({});`;
  }

  const keys = extractTopLevelArgKeys(entry.argsType);
  if (keys.length > 0) {
    const argsSnippet = keys.slice(0, 3)
      .map((key) => `${key}: ${key.toLowerCase().includes("input") ? "{ /* ... */ }" : "..."}`)
      .join(", ");
    return `await tools.${entry.path}({ ${argsSnippet} });`;
  }

  return `await tools.${entry.path}({ /* ... */ });`;
}

function buildIndex(tools: ToolDefinition[]): DiscoverIndexEntry[] {
  return tools
    .filter((tool) => tool.path !== "discover")
    .map((tool) => {
      const aliases = getPathAliases(tool.path);
      const searchText = `${tool.path} ${aliases.join(" ")} ${tool.description} ${tool.source ?? ""}`.toLowerCase();

      return {
        path: tool.path,
        aliases,
        description: tool.description,
        approval: tool.approval,
        source: tool.source ?? "local",
        argsType: normalizeType(tool.metadata?.argsType),
        returnsType: normalizeType(tool.metadata?.returnsType),
        searchText,
        normalizedPath: normalizeSearchToken(tool.path),
        normalizedSearchText: normalizeSearchToken(searchText),
      };
    });
}

function scoreEntry(entry: DiscoverIndexEntry, terms: string[]): number {
  let score = 0;
  let matched = 0;

  for (const term of terms) {
    const normalizedTerm = normalizeSearchToken(term);
    const inPath = entry.path.toLowerCase().includes(term);
    const inNormalizedPath = normalizedTerm.length > 0 && entry.normalizedPath.includes(normalizedTerm);
    const inText = entry.searchText.includes(term);
    const inNormalizedText = normalizedTerm.length > 0 && entry.normalizedSearchText.includes(normalizedTerm);
    if (!inPath && !inText && !inNormalizedPath && !inNormalizedText) continue;
    matched += 1;
    score += 1;
    if (inPath || inNormalizedPath) score += 2;
  }

  if (terms.length > 0 && matched < Math.max(1, Math.ceil(terms.length / 2))) {
    return -1;
  }

  return score + matched * 2;
}

function formatSignature(entry: DiscoverIndexEntry, depth: number): string {
  if (depth <= 0) {
    return `(input: ${entry.argsType}): Promise<...>`;
  }
  if (depth === 1) {
    return `(input: ${entry.argsType}): Promise<${entry.returnsType}>`;
  }
  return `(input: ${entry.argsType}): Promise<${entry.returnsType}> [source=${entry.source}]`;
}

export function createDiscoverTool(tools: ToolDefinition[]): ToolDefinition {
  const index = buildIndex(tools);

  return {
    path: "discover",
    source: "system",
    approval: "auto",
    description:
      "Search available tools by keyword. Returns canonical path, aliases, signature hints, and ready-to-copy call examples.",
    metadata: {
      argsType: "{ query: string; depth?: number; limit?: number }",
      returnsType:
        "{ results: Array<{ path: string; aliases: string[]; source: string; approval: 'auto' | 'required'; description: string; signature: string; exampleCall: string }>; total: number }",
    },
    run: async (input: unknown, context) => {
      const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const query = String(payload.query ?? "").trim().toLowerCase();
      const depth = Math.max(0, Math.min(2, Number(payload.depth ?? 1)));
      const limit = Math.max(1, Math.min(50, Number(payload.limit ?? 8)));
      const terms = query.length > 0 ? query.split(/\s+/).filter(Boolean) : [];

      const ranked = index
        .filter((entry) => context.isToolAllowed(entry.path))
        .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
        .filter((item) => item.score > 0 || terms.length === 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ entry }) => ({
          path: entry.path,
          aliases: entry.aliases,
          source: entry.source,
          approval: entry.approval,
          description: entry.description,
          signature: formatSignature(entry, depth),
          exampleCall: buildExampleCall(entry),
        }));

      return {
        results: ranked,
        total: ranked.length,
      };
    },
  };
}
