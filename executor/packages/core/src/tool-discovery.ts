import type { ToolDefinition } from "./types";
import {
  compactDescriptionLine,
} from "./type-hints";
import {
  buildExampleCall,
  buildExpandedShape,
  formatCanonicalSignature,
  formatSignature,
} from "./tool-discovery/formatting";
import { buildIndex, getTopLevelNamespace, listIndexForContext } from "./tool-discovery/indexing";
import { chooseBestPath, deriveIntentPhrase, extractNamespaceHints, scoreEntry } from "./tool-discovery/ranking";

export function createCatalogTools(tools: ToolDefinition[]): ToolDefinition[] {
  const index = buildIndex(tools);

  const namespacesTool: ToolDefinition = {
    path: "catalog.namespaces",
    source: "system",
    approval: "auto",
    description: "List available tool namespaces with counts and sample callable paths.",
    metadata: {
      argsType: "{}",
      returnsType: "{ namespaces: Array<{ namespace: string; toolCount: number; samplePaths: string[] }>; total: number }",
      displayArgsType: "{}",
      displayReturnsType: "{ namespaces: ...; total: number }",
    },
    run: async (_input: unknown, context) => {
      const visible = listIndexForContext(index, context.isToolAllowed);
      const grouped = new Map<string, string[]>();

      for (const entry of visible) {
        const namespace = entry.preferredPath.split(".")[0] ?? entry.path.split(".")[0] ?? "default";
        const list = grouped.get(namespace) ?? [];
        list.push(entry.preferredPath);
        grouped.set(namespace, list);
      }

      const namespaces = [...grouped.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([namespace, paths]) => ({
          namespace,
          toolCount: paths.length,
          samplePaths: [...paths].sort((a, b) => a.localeCompare(b)).slice(0, 3),
        }));

      return {
        namespaces,
        total: namespaces.length,
      };
    },
  };

  const toolsTool: ToolDefinition = {
    path: "catalog.tools",
    source: "system",
    approval: "auto",
    description: "List tools with typed signatures. Supports namespace and query filters in one call.",
    metadata: {
      argsType: "{ namespace?: string; query?: string; depth?: number; limit?: number; compact?: boolean }",
      returnsType:
        "{ results: Array<{ path: string; aliases: string[]; source: string; approval: 'auto' | 'required'; description: string; argsType: string; returnsType: string; signature: string; exampleCall: string }>; total: number }",
      displayArgsType: "{ namespace?: string; query?: string; depth?: number; limit?: number; compact?: boolean }",
      displayReturnsType: "{ results: ...; total: number }",
    },
    run: async (input: unknown, context) => {
      const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const namespaceFilter = String(payload.namespace ?? "").trim().toLowerCase();
      const query = String(payload.query ?? "").trim().toLowerCase();
      const depth = Math.max(0, Math.min(2, Number(payload.depth ?? 1)));
      const limit = Math.max(1, Math.min(200, Number(payload.limit ?? 50)));
      const compact = payload.compact === false ? false : true;
      const terms = query.length > 0 ? query.split(/\s+/).filter(Boolean) : [];

      const visible = listIndexForContext(index, context.isToolAllowed);
      const namespaceScoped = namespaceFilter.length > 0
        ? visible.filter((entry) => {
          const namespace = entry.preferredPath.split(".")[0]?.toLowerCase() ?? "";
          const canonicalNamespace = entry.path.split(".")[0]?.toLowerCase() ?? "";
          return namespace === namespaceFilter || canonicalNamespace === namespaceFilter;
        })
        : visible;

      const ranked = (terms.length > 0
        ? namespaceScoped
          .map((entry) => ({ entry, score: scoreEntry(entry, terms, new Set<string>(), "") }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((item) => item.entry)
        : [...namespaceScoped].sort((a, b) => a.preferredPath.localeCompare(b.preferredPath)))
        .slice(0, limit);

      const results = ranked.map((entry) => ({
        path: entry.preferredPath,
        aliases: entry.aliases,
        source: entry.source,
        approval: entry.approval,
        description: compact ? compactDescriptionLine(entry.description) : entry.description,
        argsType: compact ? entry.displayArgsType : entry.argsType,
        returnsType: compact ? entry.displayReturnsType : entry.returnsType,
        signature: formatSignature(entry, depth, compact),
        exampleCall: buildExampleCall(entry),
      }));

      return {
        results,
        total: results.length,
      };
    },
  };

  return [namespacesTool, toolsTool];
}

export function createDiscoverTool(tools: ToolDefinition[]): ToolDefinition {
  const index = buildIndex(tools);

  return {
    path: "discover",
    source: "system",
    approval: "auto",
    description:
      "Search available tools by keyword. Returns preferred path aliases, signature hints, and ready-to-copy call examples. Compact mode is enabled by default.",
    metadata: {
      argsType: "{ query: string; depth?: number; limit?: number; compact?: boolean }",
      returnsType:
        "{ bestPath: string | null; results: Array<{ path: string; aliases: string[]; source: string; approval: 'auto' | 'required'; description: string; signature: string; canonicalSignature: string; expandedShape: { input: string; output: string }; exampleCall: string }>; total: number }",
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

      const visibleEntries = listIndexForContext(index, context.isToolAllowed);
      const namespaceScopedEntries = namespaceHints.size > 0
        ? visibleEntries.filter((entry) => namespaceHints.has(getTopLevelNamespace(entry.path)))
        : visibleEntries;
      const candidateEntries = namespaceScopedEntries.length > 0 ? namespaceScopedEntries : visibleEntries;

      const ranked = candidateEntries
        .map((entry) => ({ entry, score: scoreEntry(entry, terms, namespaceHints, intentPhrase) }))
        .filter((item) => item.score > 0 || terms.length === 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const results = ranked.map(({ entry }) => ({
        path: entry.preferredPath,
        aliases: entry.aliases,
        source: entry.source,
        approval: entry.approval,
        description: compact ? compactDescriptionLine(entry.description) : entry.description,
        signature: formatSignature(entry, depth, compact),
        canonicalSignature: formatCanonicalSignature(entry),
        expandedShape: buildExpandedShape(entry),
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
