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

const DISCOVER_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

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

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(16, maxLength - 3)).trim()}...`;
}

function compactArgTypeHint(argsType: string): string {
  if (argsType === "{}") return "{}";
  const keys = extractTopLevelArgKeys(argsType);
  if (keys.length > 0) {
    const maxKeys = 4;
    const shown = keys.slice(0, maxKeys).map((key) => `${key}: ...`);
    const suffix = keys.length > maxKeys ? "; ..." : "";
    return `{ ${shown.join("; ")}${suffix} }`;
  }
  return truncateInline(argsType, 120);
}

function compactReturnTypeHint(returnsType: string): string {
  const normalized = returnsType.replace(/\s+/g, " ").trim();
  if (normalized.startsWith("{ data:") && normalized.includes("errors:")) {
    return "{ data: ...; errors: unknown[] }";
  }
  if (normalized.endsWith("[]") && normalized.length > 90) {
    return "Array<...>";
  }
  return truncateInline(normalized, 130);
}

function compactDescription(description: string): string {
  const firstLine = description.split("\n")[0] ?? description;
  return truncateInline(firstLine, 180);
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

function getTopLevelNamespace(path: string): string {
  return path.split(".")[0]?.toLowerCase() ?? "";
}

function extractNamespaceHints(terms: string[], namespaces: Set<string>): Set<string> {
  const hints = new Set<string>();

  for (const term of terms) {
    const direct = term.toLowerCase();
    if (namespaces.has(direct)) {
      hints.add(direct);
      continue;
    }

    const leadingSegment = direct.split(".")[0] ?? direct;
    if (namespaces.has(leadingSegment)) {
      hints.add(leadingSegment);
    }
  }

  return hints;
}

function deriveIntentPhrase(terms: string[], namespaceHints: Set<string>): string {
  const important = terms
    .map((term) => term.toLowerCase())
    .filter((term) => !namespaceHints.has(term))
    .filter((term) => !DISCOVER_STOP_WORDS.has(term))
    .filter((term) => term.length > 2);

  return normalizeSearchToken(important.join(" "));
}

function chooseBestPath(
  ranked: Array<{ entry: DiscoverIndexEntry; score: number }>,
  termCount: number,
): string | null {
  if (ranked.length === 0) return null;

  const best = ranked[0];
  if (!best) return null;

  const minScore = termCount === 0 ? 1 : Math.max(3, termCount * 2 - 1);
  if (best.score < minScore) {
    return null;
  }

  const second = ranked[1];
  if (second && best.score - second.score < 2) {
    return null;
  }

  return best.entry.path;
}

function scoreEntry(
  entry: DiscoverIndexEntry,
  terms: string[],
  namespaceHints: Set<string>,
  intentPhrase: string,
): number {
  let score = 0;
  let matched = 0;

  if (namespaceHints.size > 0) {
    const namespace = getTopLevelNamespace(entry.path);
    if (namespaceHints.has(namespace)) {
      score += 6;
    } else {
      score -= 8;
    }
  }

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

  if (intentPhrase.length >= 6) {
    if (entry.normalizedPath.includes(intentPhrase)) {
      score += 6;
    } else if (entry.normalizedSearchText.includes(intentPhrase)) {
      score += 3;
    }
  }

  if (terms.length > 0 && matched < Math.max(1, Math.ceil(terms.length / 2))) {
    return -1;
  }

  return score + matched * 2;
}

function formatSignature(entry: DiscoverIndexEntry, depth: number, compact: boolean): string {
  if (compact) {
    if (depth <= 0) {
      return "(input: ...): Promise<...>";
    }

    const args = compactArgTypeHint(entry.argsType);
    const returns = compactReturnTypeHint(entry.returnsType);

    if (depth === 1) {
      return `(input: ${args}): Promise<${returns}>`;
    }
    return `(input: ${args}): Promise<${returns}> [source=${entry.source}]`;
  }

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
      "Search available tools by keyword. Returns canonical path, aliases, signature hints, and ready-to-copy call examples. Compact mode is enabled by default.",
    metadata: {
      argsType: "{ query: string; depth?: number; limit?: number; compact?: boolean }",
      returnsType:
        "{ bestPath: string | null; results: Array<{ path: string; aliases: string[]; source: string; approval: 'auto' | 'required'; description: string; signature: string; exampleCall: string }>; total: number }",
    },
    run: async (input: unknown, context) => {
      const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const query = String(payload.query ?? "").trim().toLowerCase();
      const depth = Math.max(0, Math.min(2, Number(payload.depth ?? 1)));
      const limit = Math.max(1, Math.min(50, Number(payload.limit ?? 8)));
      const compact = payload.compact === false ? false : true;
      const terms = query.length > 0 ? query.split(/\s+/).filter(Boolean) : [];
      const namespaces = new Set(index.map((entry) => getTopLevelNamespace(entry.path)).filter(Boolean));
      const namespaceHints = extractNamespaceHints(terms, namespaces);
      const intentPhrase = deriveIntentPhrase(terms, namespaceHints);

      const visibleEntries = index.filter((entry) => context.isToolAllowed(entry.path));
      const namespaceScopedEntries = namespaceHints.size > 0
        ? visibleEntries.filter((entry) => namespaceHints.has(getTopLevelNamespace(entry.path)))
        : visibleEntries;
      const candidateEntries = namespaceScopedEntries.length > 0 ? namespaceScopedEntries : visibleEntries;

      const ranked = candidateEntries
        .map((entry) => ({ entry, score: scoreEntry(entry, terms, namespaceHints, intentPhrase) }))
        .filter((item) => item.score > 0 || terms.length === 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const results = ranked
        .map(({ entry }) => ({
          path: entry.path,
          aliases: entry.aliases,
          source: entry.source,
          approval: entry.approval,
          description: compact ? compactDescription(entry.description) : entry.description,
          signature: formatSignature(entry, depth, compact),
          exampleCall: buildExampleCall(entry),
        }));

      return {
        bestPath: chooseBestPath(ranked, terms.length),
        results,
        total: results.length,
      };
    },
  };
}
