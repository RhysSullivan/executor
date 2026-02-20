import {
  parseAsString,
  parseAsStringLiteral,
} from "nuqs";
import {
  asTrimmedString,
} from "@/lib/url-state/shared";

export const toolsApprovalValues = ["all", "required", "auto"] as const;

export type ToolsApproval = (typeof toolsApprovalValues)[number];

export const toolsCatalogQueryParsers = {
  q: parseAsString.withDefault(""),
  approval: parseAsStringLiteral(toolsApprovalValues).withDefault("all"),
  tool: parseAsString.withDefault(""),
  source: parseAsString.withDefault(""),
  sourcePanel: parseAsString.withDefault(""),
};

export type ToolsSearch = {
  q?: string;
  approval?: ToolsApproval;
  tool?: string;
  source?: string;
  sourcePanel?: string;
};

export function normalizeToolsApproval(value: unknown): ToolsApproval {
  if (value === "required" || value === "auto") {
    return value;
  }

  return "all";
}

export function normalizeToolsSearch(search: Record<string, unknown>): ToolsSearch {
  const q = asTrimmedString(search.q);
  const approval = normalizeToolsApproval(search.approval);
  const tool = asTrimmedString(search.tool);
  const source = asTrimmedString(search.source);
  const sourcePanel = asTrimmedString(search.sourcePanel);

  return {
    ...(q ? { q } : {}),
    ...(approval === "all" ? {} : { approval }),
    ...(tool ? { tool } : {}),
    ...(source ? { source } : {}),
    ...(sourcePanel ? { sourcePanel } : {}),
  };
}
