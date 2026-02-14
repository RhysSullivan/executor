import { sourceLabel, sourceType } from "@/lib/tool/source-utils";
import type { ToolDescriptor } from "@/lib/types";

export interface ToolGroup {
  key: string;
  label: string;
  type: "source" | "namespace";
  sourceType?: string;
  childCount: number;
  approvalCount: number;
  loadingPlaceholderCount?: number;
  children: Array<ToolGroup | ToolDescriptor>;
}

export function toolNamespace(path: string): string {
  const parts = path.split(".");
  if (parts.length >= 2) return parts.slice(0, -1).join(".");
  return parts[0];
}

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function trimLeadingNamespace(path: string, prefix: string): string {
  const pathTokens = normalizeTokens(path);
  const prefixTokens = normalizeTokens(prefix);
  let idx = 0;

  while (
    idx < pathTokens.length
    && idx < prefixTokens.length
    && pathTokens[idx] === prefixTokens[idx]
  ) {
    idx += 1;
  }

  return pathTokens.slice(idx).join(".");
}

export function toolOperation(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1];
}

export function toolDisplaySegment(segment: string): string {
  return segment.replace(/_/g, "-");
}

export function toolDisplayOperation(path: string): string {
  return toolDisplaySegment(toolOperation(path));
}

export function toolDisplayPath(path: string): string {
  return path
    .split(".")
    .map(toolDisplaySegment)
    .join("/");
}

function collapseMcpNamespace(namespace: string, sourceType: string): string {
  if (sourceType !== "mcp") {
    return namespace;
  }

  const parts = namespace.split(".").filter(Boolean);
  while (parts.length > 0 && parts[0] === "mcp") {
    parts.shift();
  }
  return parts.join(".");
}

export function buildSourceTree(tools: ToolDescriptor[]): ToolGroup[] {
  const bySource = new Map<string, ToolDescriptor[]>();
  for (const tool of tools) {
    const src = sourceLabel(tool.source);
    let list = bySource.get(src);
    if (!list) {
      list = [];
      bySource.set(src, list);
    }
    list.push(tool);
  }

  return Array.from(bySource.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([src, srcTools]) => {
      const sType = srcTools[0] ? sourceType(srcTools[0].source) : "local";

      const byNs = new Map<string, ToolDescriptor[]>();
      for (const tool of srcTools) {
        const ns = toolNamespace(tool.path);
        let list = byNs.get(ns);
        if (!list) {
          list = [];
          byNs.set(ns, list);
        }
        list.push(tool);
      }

      const children: Array<ToolGroup | ToolDescriptor> = [];
      for (const [ns, nsTools] of Array.from(byNs.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]))
      ) {
        const normalizedNs = collapseMcpNamespace(trimLeadingNamespace(ns, src), sType);
        const sortedNsTools = [...nsTools].sort((a, b) => a.path.localeCompare(b.path));

        if (normalizedNs.length === 0) {
          children.push(...sortedNsTools);
          continue;
        }

        children.push({
          key: `source:${src}:ns:${ns}`,
          label: normalizedNs,
          type: "namespace",
          childCount: nsTools.length,
          approvalCount: nsTools.filter((t) => t.approval === "required").length,
          children: sortedNsTools,
        });
      }

      const filteredNsChildren = children.sort((a, b) => {
        const aKey = "label" in a ? `namespace:${a.label}` : a.path;
        const bKey = "label" in b ? `namespace:${b.label}` : b.path;
        return aKey.localeCompare(bKey);
      });

      return {
        key: `source:${src}`,
        label: src,
        type: "source" as const,
        sourceType: sType,
        childCount: srcTools.length,
        approvalCount: srcTools.filter((t) => t.approval === "required")
          .length,
        children: filteredNsChildren,
      };
    });
}

export function buildNamespaceTree(tools: ToolDescriptor[]): ToolGroup[] {
  const byNs = new Map<string, ToolDescriptor[]>();
  for (const tool of tools) {
    const ns = toolNamespace(tool.path);
    let list = byNs.get(ns);
    if (!list) {
      list = [];
      byNs.set(ns, list);
    }
    list.push(tool);
  }

  return Array.from(byNs.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ns, nsTools]) => ({
        key: `ns:${ns}`,
        label: ns,
        type: "namespace" as const,
        childCount: nsTools.length,
        approvalCount: nsTools.filter((t) => t.approval === "required").length,
        children: [...nsTools].sort((a, b) => a.path.localeCompare(b.path)),
      }));
}

export function buildApprovalTree(tools: ToolDescriptor[]): ToolGroup[] {
  const gated = tools.filter((t) => t.approval === "required");
  const auto = tools.filter((t) => t.approval !== "required");
  const groups: ToolGroup[] = [];

  if (gated.length > 0) {
    groups.push({
      key: "approval:required",
      label: "Approval Required",
      type: "namespace",
      childCount: gated.length,
      approvalCount: gated.length,
      children: [...gated].sort((a, b) => a.path.localeCompare(b.path)),
    });
  }
  if (auto.length > 0) {
    groups.push({
      key: "approval:auto",
      label: "Auto-approved",
      type: "namespace",
      childCount: auto.length,
      approvalCount: 0,
      children: [...auto].sort((a, b) => a.path.localeCompare(b.path)),
    });
  }

  return groups;
}

export function collectGroupKeys(groups: ToolGroup[]): Set<string> {
  const keys = new Set<string>();
  const stack = [...groups];

  while (stack.length > 0) {
    const group = stack.pop();
    if (!group) continue;

    keys.add(group.key);
    for (const child of group.children) {
      if ("key" in child) {
        stack.push(child);
      }
    }
  }

  return keys;
}
