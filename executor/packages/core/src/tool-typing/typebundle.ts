import type { ToolDefinition } from "../types";
import { jsonSchemaTypeHintFallback } from "../openapi/schema-hints";
import { OPENAPI_HELPER_TYPES } from "../openapi/helper-types";
import { BASE_ENVIRONMENT_DTS } from "./env-types";

const memberNameRegex = /^[$A-Z_][0-9A-Z_$]*$/i;

function emitMemberName(name: string): string {
  return memberNameRegex.test(name) ? name : JSON.stringify(name);
}

function safeNamespaceSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
  return cleaned.length > 0 ? cleaned : "source";
}

function indentBlock(value: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => (line.trim().length === 0 ? line : pad + line))
    .join("\n");
}

function wrapDtsInNamespace(namespace: string, rawDts: string): string {
  const stripped = rawDts.replace(/^export /gm, "").trim();
  return `declare namespace ${namespace} {\n${indentBlock(stripped, 2)}\n}`;
}

function typeHintFromSchema(schema: Record<string, unknown> | undefined, fallback: string): string {
  if (!schema || Object.keys(schema).length === 0) return fallback;
  // Special-case empty object input to keep signatures tidy.
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (Object.keys(props).length === 0 && required.length === 0) {
    return fallback === "{}" ? "{}" : fallback;
  }
  return jsonSchemaTypeHintFallback(schema);
}

type NamespaceNode = {
  children: Map<string, NamespaceNode>;
  tools: ToolDefinition[];
};

function buildTree(tools: ToolDefinition[]): NamespaceNode {
  const root: NamespaceNode = { children: new Map(), tools: [] };
  for (const tool of tools) {
    const parts = tool.path.split(".");
    if (parts.length <= 1) {
      root.tools.push(tool);
      continue;
    }

    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      if (!node.children.has(part)) {
        node.children.set(part, { children: new Map(), tools: [] });
      }
      node = node.children.get(part)!;
    }
    node.tools.push(tool);
  }
  return root;
}

function countAllTools(node: NamespaceNode): number {
  let count = node.tools.length;
  for (const child of node.children.values()) {
    count += countAllTools(child);
  }
  return count;
}

function emitToolMethod(tool: ToolDefinition, openApiSourcesWithDts: Set<string>): string {
  const methodName = emitMemberName(tool.path.split(".").at(-1) ?? "tool");
  const approvalNote = tool.approval === "required" ? " **Requires approval**" : "";
  const desc = (tool.description || "Call this tool.") + approvalNote;

  const typing = tool.typing;
  const typedRef = typing?.typedRef;

  let inputType = "Record<string, unknown>";
  let outputType = "unknown";

  if (typedRef?.kind === "openapi_operation" && openApiSourcesWithDts.has(typedRef.sourceKey)) {
    const ns = `OpenApi_${safeNamespaceSegment(typedRef.sourceKey)}`;
    const opKey = JSON.stringify(typedRef.operationId);
    inputType = `ToolInput<${ns}.operations[${opKey}]>`;
    outputType = `ToolOutput<${ns}.operations[${opKey}]>`;
  } else {
    inputType = typeHintFromSchema(typing?.inputSchema, "{}");
    outputType = typeHintFromSchema(typing?.outputSchema, "unknown");
  }

  const isOptionalInput = inputType === "{}";
  const inputParam = isOptionalInput ? `input?: ${inputType}` : `input: ${inputType}`;

  return `  /**\n   * ${desc}\n   */\n  ${methodName}(${inputParam}): Promise<${outputType}>;`;
}

function emitNamespaceInterface(
  name: string,
  node: NamespaceNode,
  openApiSourcesWithDts: Set<string>,
  out: string[],
): void {
  for (const [childName, childNode] of node.children) {
    emitNamespaceInterface(`${name}_${childName}`, childNode, openApiSourcesWithDts, out);
  }

  const members: string[] = [];
  for (const [childName, childNode] of node.children) {
    const toolCount = childNode.tools.length + countAllTools(childNode);
    members.push(
      `  /** ${toolCount} tool${toolCount !== 1 ? "s" : ""} in the \`${childName}\` namespace */\n  readonly ${emitMemberName(childName)}: ToolNS_${name}_${childName};`,
    );
  }
  for (const tool of node.tools) {
    members.push(emitToolMethod(tool, openApiSourcesWithDts));
  }

  out.push(`interface ToolNS_${name} {\n${members.join("\n\n")}\n}`);
}

function emitToolsProxyDts(tools: ToolDefinition[], openApiSourcesWithDts: Set<string>): string {
  const root = buildTree(tools);

  const interfaces: string[] = [];
  for (const [name, node] of root.children) {
    emitNamespaceInterface(name, node, openApiSourcesWithDts, interfaces);
  }

  const rootMembers: string[] = [];
  for (const [name] of root.children) {
    rootMembers.push(`  readonly ${emitMemberName(name)}: ToolNS_${name};`);
  }
  for (const tool of root.tools) {
    rootMembers.push(emitToolMethod(tool, openApiSourcesWithDts));
  }

  return [
    interfaces.join("\n\n"),
    "",
    "interface ToolsProxy {",
    rootMembers.join("\n\n"),
    "}",
    "",
    "declare const tools: ToolsProxy;",
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

export interface BuildWorkspaceTypeBundleInput {
  tools: ToolDefinition[];
  /** Map of OpenAPI sourceKey -> openapi-typescript .d.ts string */
  openApiDtsBySource?: Record<string, string>;
}

/**
 * Builds a single `.d.ts` bundle suitable for Monaco's `addExtraLib`.
 *
 * - Includes base environment declarations.
 * - Includes OpenAPI helper types (`ToolInput`/`ToolOutput`).
 * - Namespaces each OpenAPI source `.d.ts` to avoid global `operations` collisions.
 * - Emits `declare const tools: ToolsProxy` for IntelliSense.
 */
export function buildWorkspaceTypeBundle(input: BuildWorkspaceTypeBundleInput): string {
  const openApiDtsBySource = input.openApiDtsBySource ?? {};
  const openApiSourcesWithDts = new Set(Object.keys(openApiDtsBySource));

  const openApiBlocks = Object.entries(openApiDtsBySource)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sourceKey, dts]) => {
      const ns = `OpenApi_${safeNamespaceSegment(sourceKey)}`;
      return wrapDtsInNamespace(ns, dts);
    });

  return [
    "// Generated workspace type bundle",
    BASE_ENVIRONMENT_DTS.trim(),
    OPENAPI_HELPER_TYPES.trim(),
    ...openApiBlocks,
    emitToolsProxyDts(input.tools, openApiSourcesWithDts),
    "",
  ].join("\n\n");
}
