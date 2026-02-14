import type { ToolDescriptor } from "@/lib/types";
export { OPENAPI_HELPER_TYPES } from "@executor/core/openapi/helper-types";
import { toolDisplaySegment } from "@/lib/tool/explorer-grouping";

interface NamespaceNode {
  children: Map<string, NamespaceNode>;
  tools: ToolDescriptor[];
}

function buildTree(tools: ToolDescriptor[]): NamespaceNode {
  const root: NamespaceNode = { children: new Map(), tools: [] };
  for (const tool of tools) {
    const parts = tool.path.split(".");
    if (parts.length === 1) {
      root.tools.push(tool);
    } else {
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node.children.has(parts[i])) {
          node.children.set(parts[i], { children: new Map(), tools: [] });
        }
        node = node.children.get(parts[i])!;
      }
      node.tools.push(tool);
    }
  }
  return root;
}

const memberNameRegex = /^[$A-Z_][0-9A-Z_$]*$/i;

function emitMemberName(name: string): string {
  if (memberNameRegex.test(name)) {
    return name;
  }

  return JSON.stringify(name);
}

function countAllTools(node: NamespaceNode): number {
  let count = node.tools.length;
  for (const child of node.children.values()) {
    count += countAllTools(child);
  }
  return count;
}

function emitToolMethod(tool: ToolDescriptor, dtsSources: Set<string>): string {
  const funcName = emitMemberName(toolDisplaySegment(tool.path.split(".").pop()!));
  const approvalNote =
    tool.approval === "required"
      ? " **Requires approval** - execution will pause until approved."
      : "";
  const desc = tool.description
    ? `${tool.description}${approvalNote}`
    : approvalNote || "Call this tool.";

  const hasSourceDts = Boolean(tool.source && dtsSources.has(tool.source));
  if (tool.operationId && hasSourceDts) {
    const opKey = JSON.stringify(tool.operationId);
    return `  /**
   * ${desc}
   *${tool.source ? ` @source ${tool.source}` : ""}
   */
  ${funcName}(input: ToolInput<operations[${opKey}]>): Promise<ToolOutput<operations[${opKey}]>>;`;
  }

  const strictArgsType = tool.strictArgsType?.trim();
  const strictReturnsType = tool.strictReturnsType?.trim();
  const fallbackArgsType = tool.argsType?.trim();
  const fallbackReturnsType = tool.returnsType?.trim();
  const hasArgsType = Boolean(strictArgsType || fallbackArgsType);
  const argsType = strictArgsType || fallbackArgsType || "Record<string, unknown>";
  const returnsType = strictReturnsType || fallbackReturnsType || "unknown";
  const inputParam = !hasArgsType || argsType === "{}" ? `input?: ${argsType}` : `input: ${argsType}`;

  return `  /**
   * ${desc}
   *${tool.source ? ` @source ${tool.source}` : ""}
   */
  ${funcName}(${inputParam}): Promise<${returnsType}>;`;
}

function emitNamespaceInterface(
  name: string,
  node: NamespaceNode,
  dtsSources: Set<string>,
  out: string[],
): void {
  for (const [childName, childNode] of node.children) {
    emitNamespaceInterface(`${name}_${childName}`, childNode, dtsSources, out);
  }

  const members: string[] = [];

  for (const [childName, childNode] of node.children) {
    const toolCount = childNode.tools.length + countAllTools(childNode);
    members.push(`  /** ${toolCount} tool${toolCount !== 1 ? "s" : ""} in the \`${childName}\` namespace */
  readonly ${emitMemberName(toolDisplaySegment(childName))}: ToolNS_${name}_${childName};`);
  }

  for (const tool of node.tools) {
    members.push(emitToolMethod(tool, dtsSources));
  }

  out.push(`interface ToolNS_${name} {\n${members.join("\n\n")}\n}`);
}

export function generateToolsDts(tools: ToolDescriptor[], dtsSources: Set<string>): string {
  const root = buildTree(tools);

  const interfaces: string[] = [];
  for (const [name, node] of root.children) {
    emitNamespaceInterface(name, node, dtsSources, interfaces);
  }

  const rootMembers: string[] = [];
  for (const [name] of root.children) {
    rootMembers.push(`  readonly ${emitMemberName(toolDisplaySegment(name))}: ToolNS_${name};`);
  }
  for (const tool of root.tools) {
    rootMembers.push(emitToolMethod(tool, dtsSources));
  }

  let dts = `
/**
 * The \`tools\` object is a proxy that lets you call registered executor tools.
 * Each call returns a Promise with the tool's result.
 * Tools marked with "approval: required" will pause execution until approved.
 */
`;

  dts += interfaces.join("\n\n") + "\n\n";
  dts += `interface ToolsProxy {\n${rootMembers.join("\n\n")}\n}\n\n`;
  dts += "declare const tools: ToolsProxy;\n";

  return dts;
}

export const BASE_ENVIRONMENT_DTS = `
interface Console {
  /** Console output is discarded; use explicit return values for results. */
  log(...args: any[]): void;
  /** Console output is discarded; use explicit return values for results. */
  error(...args: any[]): void;
  /** Console output is discarded; use explicit return values for results. */
  warn(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
}
declare var console: Console;

declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): number;
declare function clearTimeout(id: number): void;
declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): number;
declare function clearInterval(id: number): void;
`;
