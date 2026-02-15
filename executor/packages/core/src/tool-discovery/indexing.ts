import type { ToolDefinition } from "../types";
import { jsonSchemaTypeHintFallback } from "../openapi/schema-hints";
import { buildPreviewKeys, extractTopLevelRequiredKeys } from "../tool-typing/schema-utils";
import { sanitizeJsonSchemaForConvex } from "../tool-typing/convex-sanitize";
import type { DiscoverIndexEntry } from "./types";

const GENERIC_NAMESPACE_SUFFIXES = new Set([
  "api",
  "apis",
  "openapi",
  "sdk",
  "service",
  "services",
]);

function normalizeHint(type?: string): string {
  return type && type.trim().length > 0 ? type : "unknown";
}

function isEmptyObjectSchema(schema: Record<string, unknown>): boolean {
  if (Object.keys(schema).length === 0) return true;
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.keys(props).length === 0 && required.length === 0;
}

export function normalizeSearchToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokenizePathSegment(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

  return normalized
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function simplifyNamespaceSegment(segment: string): string {
  const tokens = tokenizePathSegment(segment);
  if (tokens.length === 0) return segment;

  const collapsed: string[] = [];
  for (const token of tokens) {
    if (collapsed[collapsed.length - 1] === token) continue;
    collapsed.push(token);
  }

  while (collapsed.length > 1) {
    const last = collapsed[collapsed.length - 1];
    if (!last || !GENERIC_NAMESPACE_SUFFIXES.has(last)) break;
    collapsed.pop();
  }

  return collapsed.join("_");
}

function preferredToolPath(path: string): string {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return path;

  const simplifiedNamespace = simplifyNamespaceSegment(segments[0]!);
  if (!simplifiedNamespace || simplifiedNamespace === segments[0]) {
    return path;
  }

  return [simplifiedNamespace, ...segments.slice(1)].join(".");
}

function toCamelSegment(segment: string): string {
  return segment.replace(/_+([a-z0-9])/g, (_m, char: string) => char.toUpperCase());
}

function getPathAliases(path: string): string[] {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return [];

  const canonicalPath = path;
  const publicPath = preferredToolPath(path);

  const aliases = new Set<string>();
  const publicSegments = publicPath.split(".").filter(Boolean);
  const camelPath = publicSegments.map(toCamelSegment).join(".");
  const compactPath = publicSegments.map((segment) => segment.replace(/[_-]/g, "")).join(".");
  const lowerPath = publicPath.toLowerCase();

  if (publicPath !== canonicalPath) aliases.add(publicPath);
  if (camelPath !== publicPath) aliases.add(camelPath);
  if (compactPath !== publicPath) aliases.add(compactPath);
  if (lowerPath !== publicPath) aliases.add(lowerPath);

  return [...aliases].slice(0, 4);
}

export function buildIndex(tools: ToolDefinition[]): DiscoverIndexEntry[] {
  return tools
    .filter((tool) => tool.path !== "discover" && !tool.path.startsWith("catalog."))
    .map((tool) => {
      const preferredPath = preferredToolPath(tool.path);
      const aliases = getPathAliases(tool.path);
      const searchText = `${tool.path} ${preferredPath} ${aliases.join(" ")} ${tool.description} ${tool.source ?? ""}`.toLowerCase();

      const inputSchema = (tool.typing?.inputSchema && typeof tool.typing.inputSchema === "object")
        ? tool.typing.inputSchema
        : {};
      const outputSchema = (tool.typing?.outputSchema && typeof tool.typing.outputSchema === "object")
        ? tool.typing.outputSchema
        : {};

      const safeInputSchema = sanitizeJsonSchemaForConvex(inputSchema);
      const safeOutputSchema = sanitizeJsonSchemaForConvex(outputSchema);

      const requiredInputKeys = Array.isArray(tool.typing?.requiredInputKeys)
        ? tool.typing!.requiredInputKeys!.filter((value): value is string => typeof value === "string")
        : extractTopLevelRequiredKeys(inputSchema);
      const previewInputKeys = Array.isArray(tool.typing?.previewInputKeys)
        ? tool.typing!.previewInputKeys!.filter((value): value is string => typeof value === "string")
        : buildPreviewKeys(inputSchema);

      const displayInputHint = normalizeHint(
        isEmptyObjectSchema(inputSchema) ? "{}" : jsonSchemaTypeHintFallback(inputSchema),
      );
      const displayOutputHint = normalizeHint(
        Object.keys(outputSchema).length === 0 ? "unknown" : jsonSchemaTypeHintFallback(outputSchema),
      );

      return {
        path: tool.path,
        preferredPath,
        aliases,
        description: tool.description,
        approval: tool.approval,
        source: tool.source ?? "local",
        inputSchema: safeInputSchema,
        outputSchema: safeOutputSchema,
        requiredInputKeys,
        previewInputKeys,
        displayInputHint,
        displayOutputHint,
        searchText,
        normalizedPath: normalizeSearchToken(tool.path),
        normalizedSearchText: normalizeSearchToken(searchText),
      };
    });
}

export function listIndexForContext(
  index: DiscoverIndexEntry[],
  isToolAllowed: (toolPath: string) => boolean,
): DiscoverIndexEntry[] {
  return index.filter((entry) => isToolAllowed(entry.path));
}

export function getTopLevelNamespace(path: string): string {
  return path.split(".")[0]?.toLowerCase() ?? "";
}
