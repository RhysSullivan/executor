import type { ToolDefinition } from "./types";
import { z } from "zod";
import {
  compactDescriptionLine,
} from "./type-hints";
import {
  buildExampleCall,
  formatCanonicalSignature,
  formatSignature,
} from "./tool-discovery/formatting";
import { buildIndex, getTopLevelNamespace, listIndexForContext } from "./tool-discovery/indexing";
import { chooseBestPath, deriveIntentPhrase, extractNamespaceHints, scoreEntry } from "./tool-discovery/ranking";
const recordSchema = z.record(z.unknown());

const catalogToolsInputSchema = z.object({
  namespace: z.string().optional(),
  query: z.string().optional(),
  depth: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  compact: z.boolean().optional(),
  includeSchemas: z.boolean().optional(),
});

const discoverInputSchema = z.object({
  query: z.string().optional(),
  depth: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  compact: z.boolean().optional(),
  includeSchemas: z.boolean().optional(),
});

interface DiscoveryBuildOptions {
  sourceRefHintTables?: Record<string, Record<string, string>>;
}

function mergeRefHintsIntoTable(target: Record<string, string>, refHints: Record<string, string>): void {
  for (const [key, value] of Object.entries(refHints)) {
    if (!target[key]) {
      target[key] = value;
    }
  }
}

export function createCatalogTools(tools: ToolDefinition[], options: DiscoveryBuildOptions = {}): ToolDefinition[] {
  const index = buildIndex(tools, options);

  const namespacesTool: ToolDefinition = {
    path: "catalog.namespaces",
    source: "system",
    approval: "auto",
    description: "List available tool namespaces with counts and sample callable paths.",
    typing: {
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { namespaces: { type: "array" }, total: { type: "number" } }, required: ["namespaces", "total"] },
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
    typing: {
      inputSchema: {
        type: "object",
        properties: {
          namespace: { type: "string" },
          query: { type: "string" },
          depth: { type: "number" },
          limit: { type: "number" },
          compact: { type: "boolean" },
          includeSchemas: { type: "boolean" },
        },
      },
      outputSchema: { type: "object", properties: { results: { type: "array" }, total: { type: "number" } }, required: ["results", "total"] },
    },
    run: async (input: unknown, context) => {
      const payload = recordSchema.safeParse(input);
      const normalizedPayload = payload.success ? payload.data : {};
      const parsedInput = catalogToolsInputSchema.safeParse(normalizedPayload);
      const namespaceFilter = (parsedInput.success ? (parsedInput.data.namespace ?? "") : "").trim().toLowerCase();
      const query = (parsedInput.success ? (parsedInput.data.query ?? "") : "").trim().toLowerCase();
      const depthValue = parsedInput.success ? parsedInput.data.depth : undefined;
      const depth = Math.max(0, Math.min(2, Number(depthValue ?? 1)));
      const limitValue = parsedInput.success ? parsedInput.data.limit : undefined;
      const limit = Math.max(1, Math.min(200, Number(limitValue ?? 50)));
      const compact = parsedInput.success ? (parsedInput.data.compact ?? true) : true;
      const includeSchemas = parsedInput.success ? (parsedInput.data.includeSchemas ?? false) : false;
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

      const refHintTable: Record<string, string> = {};
      const results = ranked.map((entry) => {
        mergeRefHintsIntoTable(refHintTable, entry.refHints);

        return {
          path: entry.preferredPath,
          aliases: entry.aliases,
          source: entry.source,
          approval: entry.approval,
          description: compact ? compactDescriptionLine(entry.description) : entry.description,
          signatureInfo: {
            input: entry.displayInputHint,
            output: entry.displayOutputHint,
            requiredKeys: entry.requiredInputKeys,
            previewKeys: entry.previewInputKeys,
            ...(entry.refHintKeys.length > 0 ? { refHintKeys: entry.refHintKeys } : {}),
            ...(includeSchemas && !compact ? { inputSchema: entry.inputSchema, outputSchema: entry.outputSchema } : {}),
          },
          signatureText: formatSignature(entry, depth, compact),
          canonicalSignature: formatCanonicalSignature(entry),
          exampleCall: buildExampleCall(entry),
        };
      });

      return {
        results,
        total: results.length,
        ...(Object.keys(refHintTable).length > 0 ? { refHintTable } : {}),
      };
    },
  };

  return [namespacesTool, toolsTool];
}

export function createDiscoverTool(tools: ToolDefinition[], options: DiscoveryBuildOptions = {}): ToolDefinition {
  const index = buildIndex(tools, options);

  return {
    path: "discover",
    source: "system",
    approval: "auto",
    description:
      "Search available tools by keyword. Returns preferred path aliases, signature hints, and ready-to-copy call examples. Compact mode is enabled by default.",
    typing: {
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          depth: { type: "number" },
          limit: { type: "number" },
          compact: { type: "boolean" },
          includeSchemas: { type: "boolean" },
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: {
          bestPath: {},
          results: { type: "array" },
          total: { type: "number" },
        },
        required: ["bestPath", "results", "total"],
      },
    },
    run: async (input: unknown, context) => {
      const payload = recordSchema.safeParse(input);
      const normalizedPayload = payload.success ? payload.data : {};
      const parsedInput = discoverInputSchema.safeParse(normalizedPayload);
      const query = (parsedInput.success ? (parsedInput.data.query ?? "") : "").trim().toLowerCase();
      const depthValue = parsedInput.success ? parsedInput.data.depth : undefined;
      const depth = Math.max(0, Math.min(2, Number(depthValue ?? 1)));
      const limitValue = parsedInput.success ? parsedInput.data.limit : undefined;
      const limit = Math.max(1, Math.min(50, Number(limitValue ?? 8)));
      const compact = parsedInput.success ? (parsedInput.data.compact ?? true) : true;
      const includeSchemas = parsedInput.success ? (parsedInput.data.includeSchemas ?? false) : false;
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

      const refHintTable: Record<string, string> = {};
      const results = ranked.map(({ entry }) => {
        mergeRefHintsIntoTable(refHintTable, entry.refHints);

        return {
          path: entry.preferredPath,
          aliases: entry.aliases,
          source: entry.source,
          approval: entry.approval,
          description: compact ? compactDescriptionLine(entry.description) : entry.description,
          signature: formatSignature(entry, depth, compact),
          canonicalSignature: formatCanonicalSignature(entry),
          signatureInfo: {
            input: entry.displayInputHint,
            output: entry.displayOutputHint,
            requiredKeys: entry.requiredInputKeys,
            previewKeys: entry.previewInputKeys,
            ...(entry.refHintKeys.length > 0 ? { refHintKeys: entry.refHintKeys } : {}),
            ...(includeSchemas && !compact ? { inputSchema: entry.inputSchema, outputSchema: entry.outputSchema } : {}),
          },
          exampleCall: buildExampleCall(entry),
        };
      });

      return {
        bestPath: chooseBestPath(ranked, terms.length),
        results,
        total: results.length,
        ...(Object.keys(refHintTable).length > 0 ? { refHintTable } : {}),
      };
    },
  };
}
