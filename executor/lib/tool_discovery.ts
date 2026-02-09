import type { ToolDefinition } from "./types";

interface DiscoverIndexEntry {
  path: string;
  description: string;
  approval: ToolDefinition["approval"];
  source: string;
  argsType: string;
  returnsType: string;
  searchText: string;
}

function normalizeType(type?: string): string {
  return type && type.trim().length > 0 ? type : "unknown";
}

function buildIndex(tools: ToolDefinition[]): DiscoverIndexEntry[] {
  return tools
    .filter((tool) => tool.path !== "discover")
    .map((tool) => ({
      path: tool.path,
      description: tool.description,
      approval: tool.approval,
      source: tool.source ?? "local",
      argsType: normalizeType(tool.metadata?.argsType),
      returnsType: normalizeType(tool.metadata?.returnsType),
      searchText: `${tool.path} ${tool.description} ${tool.source ?? ""}`.toLowerCase(),
    }));
}

function scoreEntry(entry: DiscoverIndexEntry, terms: string[]): number {
  let score = 0;
  let matched = 0;

  for (const term of terms) {
    const inPath = entry.path.toLowerCase().includes(term);
    const inText = entry.searchText.includes(term);
    if (!inPath && !inText) continue;
    matched += 1;
    score += 1;
    if (inPath) score += 2;
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
      "Search available tools by keyword. Returns tool path, source, approval mode, and signature hints so code can call tools accurately.",
    metadata: {
      argsType: "{ query: string; depth?: number; limit?: number }",
      returnsType:
        "{ results: Array<{ path: string; source: string; approval: 'auto' | 'required'; description: string; signature: string }>; total: number }",
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
          source: entry.source,
          approval: entry.approval,
          description: entry.description,
          signature: formatSignature(entry, depth),
        }));

      return {
        results: ranked,
        total: ranked.length,
      };
    },
  };
}
