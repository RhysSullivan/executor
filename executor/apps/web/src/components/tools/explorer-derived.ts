import {
  buildApprovalTree,
  buildNamespaceTree,
  buildSourceTree,
  toolNamespace,
  type ToolGroup,
} from "@/lib/tool/explorer-grouping";
import { sourceLabel } from "@/lib/tool/source-utils";
import type { ToolDescriptor } from "@/lib/types";
import type { ToolSourceRecord } from "@/lib/types";
import type { GroupBy, ViewMode } from "./explorer-toolbar";

export type FilterApproval = "all" | "required" | "auto";

function normalizeSearchToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function splitSearchTerms(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function expandSearchToken(token: string): string[] {
  const variants = new Set<string>([token]);
  if (token.endsWith("s") && token.length > 2) {
    variants.add(token.slice(0, -1));
  }
  const compact = normalizeSearchToken(token);
  if (compact.length > 0) {
    variants.add(compact);
  }

  const compactSingular = token.endsWith("s") && token.length > 2
    ? token.slice(0, -1)
    : token;
  if (compactSingular !== token) {
    variants.add(normalizeSearchToken(compactSingular));
  }

  return Array.from(variants);
}

function buildSearchNeedles(search: string): string[][] {
  const tokens = splitSearchTerms(search);
  return tokens.map((token) => Array.from(new Set(expandSearchToken(token))));
}

function buildToolSearchTokens(tool: ToolDescriptor): string[] {
  const pathAndDescription = `${tool.path} ${tool.description}`;
  const tokens = splitSearchTerms(pathAndDescription);
  const normalized = new Set<string>([normalizeSearchToken(pathAndDescription)]);
  for (const token of tokens) {
    for (const variant of expandSearchToken(token)) {
      if (variant.length > 0) {
        normalized.add(variant);
      }
    }
  }

  return Array.from(normalized);
}

function tokenMatchesNeedle(token: string, needle: string): boolean {
  return token.includes(needle)
    || token.includes(needle.replace(/_/g, ""))
    || normalizeSearchToken(token).includes(needle);
}

function matchesSearchNeedles(tool: ToolDescriptor, searchNeedles: string[][]): boolean {
  const haystack = buildToolSearchTokens(tool);
  return searchNeedles.every((needles) => {
    if (needles.length === 0) {
      return true;
    }

    return haystack.some((token) =>
      needles.some((needle) => tokenMatchesNeedle(token, needle)),
    );
  });
}

export function filterToolsBySourceAndApproval(
  tools: ToolDescriptor[],
  activeSource: string | null,
  filterApproval: FilterApproval,
): ToolDescriptor[] {
  let result = tools;

  if (activeSource) {
    result = result.filter((tool) => sourceLabel(tool.source) === activeSource);
  }

  if (filterApproval === "required") {
    result = result.filter((tool) => tool.approval === "required");
  } else if (filterApproval === "auto") {
    result = result.filter((tool) => tool.approval !== "required");
  }

  return result;
}

export function filterToolsBySearch(
  tools: ToolDescriptor[],
  search: string,
): ToolDescriptor[] {
  if (!search) {
    return tools;
  }

  const searchNeedles = buildSearchNeedles(search);
  return tools.filter(
    (tool) =>
      matchesSearchNeedles(tool, searchNeedles),
  );
}

export function treeGroupsForView(
  tools: ToolDescriptor[],
  viewMode: ViewMode,
  groupBy: GroupBy,
  options?: {
    loadingSources?: string[];
    sourceRecords?: ToolSourceRecord[];
    sourceCounts?: Record<string, number>;
    activeSource?: string | null;
  },
): ToolGroup[] {
  if (viewMode === "flat") {
    return [];
  }

  if (groupBy === "source") {
    return buildSourceTreeWithLoading(
      buildSourceTree(tools),
      options?.loadingSources ?? [],
      options?.sourceRecords ?? [],
      options?.sourceCounts ?? {},
      options?.activeSource ?? null,
    );
  }

  if (groupBy === "namespace") {
    return buildNamespaceTree(tools);
  }

  return buildApprovalTree(tools);
}

function buildSourceTreeWithLoading(
  groups: ToolGroup[],
  loadingSources: string[],
  sourceRecords: ToolSourceRecord[],
  sourceCounts: Record<string, number>,
  activeSource: string | null,
): ToolGroup[] {
  const groupsBySource = new Map(
    groups
      .filter((group) => group.type === "source")
      .map((group) => [group.label, group]),
  );
  const sourceTypeByName = new Map<string, string>(
    sourceRecords.map((source) => [source.name, source.type]),
  );

  for (const source of sourceRecords) {
    if (activeSource && source.name !== activeSource) {
      continue;
    }

    if (!groupsBySource.has(source.name)) {
      groupsBySource.set(source.name, {
        key: `source:${source.name}`,
        label: source.name,
        type: "source",
        sourceType: source.type,
        childCount: sourceCounts[source.name] ?? 0,
        approvalCount: 0,
        children: [],
      });
    }
  }

  const loadingPlaceholders = loadingSources
    .filter((sourceName) =>
      (activeSource ? sourceName === activeSource : true)
      && !groupsBySource.has(sourceName),
    )
    .map((sourceName) => ({
      key: `source:${sourceName}`,
      label: sourceName,
      type: "source" as const,
      sourceType: sourceTypeByName.get(sourceName) ?? "local",
      childCount: sourceCounts[sourceName] ?? 0,
      approvalCount: 0,
      loadingPlaceholderCount: 3,
      children: [],
    }));

  for (const placeholder of loadingPlaceholders) {
    groupsBySource.set(placeholder.label, placeholder);
  }

  if (loadingSources.length > 0) {
    for (const sourceName of loadingSources) {
      const existing = groupsBySource.get(sourceName);
      if (!existing) {
        continue;
      }

      groupsBySource.set(sourceName, {
        ...existing,
        loadingPlaceholderCount: existing.loadingPlaceholderCount ?? 3,
      });
    }
  }

  return [...groupsBySource.values()].sort((a, b) => {
    if (a.label === "system") return 1;
    if (b.label === "system") return -1;
    return a.label.localeCompare(b.label);
  });
}

export function autoExpandedKeysForSearch(
  search: string,
  filteredTools: ToolDescriptor[],
  viewMode: ViewMode,
): Set<string> | null {
  if (search.length < 2 || viewMode !== "tree") {
    return null;
  }

  const allGroupKeys = new Set<string>();
  const searchNeedles = buildSearchNeedles(search);
  const matching = filteredTools.filter(
    (tool) => matchesSearchNeedles(tool, searchNeedles),
  );

  for (const tool of matching) {
    const source = sourceLabel(tool.source);
    const namespace = toolNamespace(tool.path);
    allGroupKeys.add(`source:${source}`);
    allGroupKeys.add(`source:${source}:ns:${namespace}`);
    allGroupKeys.add(`ns:${namespace}`);
  }

  return allGroupKeys;
}
