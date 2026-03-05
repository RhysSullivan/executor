import * as Effect from "effect/Effect";

import type { RuntimeAdapterError } from "./runtime-adapters";
import type {
  ToolRegistry,
  ToolRegistryNamespaceSummary,
  ToolRegistryToolSummary,
} from "./tool-registry";

export type ExecuteToolExposureMode = "all_tools" | "sources_only";

export type BuildExecuteToolDescriptionOptions = {
  toolRegistry: ToolRegistry;
  mode: ExecuteToolExposureMode;
  namespaceLimit?: number;
  toolLimitPerNamespace?: number;
};

export const defaultExecuteToolExposureMode: ExecuteToolExposureMode =
  "sources_only";

export const defaultExecuteToolDescription =
  "Execute JavaScript against configured runtime";

const defaultDiscoveryNamespaceLimit = 200;
const maxNamespaceDescriptionRows = 5_000;
const maxToolDescriptionRows = 50_000;

const normalizeMode = (value: string): string => value.trim().toLowerCase();

export const parseExecuteToolExposureMode = (
  value: string | undefined,
): ExecuteToolExposureMode | null => {
  if (!value) {
    return null;
  }

  const normalized = normalizeMode(value);

  if (
    normalized === "all_tools" ||
    normalized === "all-tools" ||
    normalized === "alltools" ||
    normalized === "all"
  ) {
    return "all_tools";
  }

  if (
    normalized === "sources_only" ||
    normalized === "sources-only" ||
    normalized === "sourcesonly" ||
    normalized === "sources"
  ) {
    return "sources_only";
  }

  return null;
};

const quote = (value: string): string => JSON.stringify(value);

const namespaceLine = (namespace: ToolRegistryNamespaceSummary): string => {
  const sourceLabel = namespace.source ? `source=${namespace.source}` : "source=unknown";
  const sourceKeyLabel = namespace.sourceKey
    ? ` sourceKey=${namespace.sourceKey}`
    : "";
  const description = namespace.description
    ? ` - ${namespace.description}`
    : "";

  return `- ${namespace.namespace} (${sourceLabel}${sourceKeyLabel}, tools=${namespace.toolCount})${description}`;
};

const toolLine = (tool: ToolRegistryToolSummary): string => {
  const sourceLabel = tool.source ? ` source=${tool.source}` : "";
  const description = tool.description ? ` - ${tool.description}` : "";
  const inputHint = tool.inputHint ? ` | input=${tool.inputHint}` : "";
  const outputHint = tool.outputHint ? ` | output=${tool.outputHint}` : "";
  return `- ${tool.path}${sourceLabel}${description}${inputHint}${outputHint}`;
};

const dedupeToolsByPath = (
  tools: ReadonlyArray<ToolRegistryToolSummary>,
): Array<ToolRegistryToolSummary> => {
  const byPath = new Map<string, ToolRegistryToolSummary>();

  for (const tool of tools) {
    if (!byPath.has(tool.path)) {
      byPath.set(tool.path, tool);
    }
  }

  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
};

const discoveryGuide = [
  "Discovery workflow:",
  "0) Use discover/catalog for external APIs; do not use fetch.",
  `1) const namespaces = await tools.catalog.namespaces({ limit: ${defaultDiscoveryNamespaceLimit} });`,
  "   (Object.keys(tools) exposes only helper roots like discover/catalog.)",
  `2) const matches = await tools.discover({ queries: [{ text: "<intent>", depth: 1 }], limit: 12 });`,
  "   (Use includeSchemas: true when you need full input/output schema JSON.)",
  "3) call the selected tool path via tools.<namespace>.<...>(input)",
  "4) HTTP/OpenAPI tool calls return { status, headers, body }. Read res.body for payload data.",
].join("\n");

const formatSourcesOnlyDescription = (
  namespaces: ReadonlyArray<ToolRegistryNamespaceSummary>,
): string => {
  const sourceLines = namespaces.length
    ? namespaces.map(namespaceLine).join("\n")
    : "- No enabled sources are currently available";

  return [
    defaultExecuteToolDescription,
    "",
    "Mode: sources_only",
    "Only source-level context is preloaded. Discover tool paths at runtime.",
    "",
    "Sources:",
    sourceLines,
    "",
    discoveryGuide,
  ].join("\n");
};

const formatAllToolsDescription = (
  namespaces: ReadonlyArray<ToolRegistryNamespaceSummary>,
  tools: ReadonlyArray<ToolRegistryToolSummary>,
): string => {
  const sourceLines = namespaces.length
    ? namespaces.map(namespaceLine).join("\n")
    : "- No enabled sources are currently available";

  const toolLines = tools.length
    ? tools.map(toolLine).join("\n")
    : "- No tools are currently available";

  return [
    defaultExecuteToolDescription,
    "",
    "Mode: all_tools",
    "All known tools are preloaded below.",
    "",
    "Sources:",
    sourceLines,
    "",
    "Tool paths:",
    toolLines,
    "",
    "Use tool paths above; do not use fetch for external APIs.",
    "",
    `Tip: if a path fails, run tools.discover({ queries: [{ text: ${quote("<intent>")}, depth: 1 }] }) for correction hints.`,
  ].join("\n");
};

const normalizeNamespaces = (
  namespaces: ReadonlyArray<ToolRegistryNamespaceSummary>,
): Array<ToolRegistryNamespaceSummary> =>
  [...namespaces].sort((left, right) => left.namespace.localeCompare(right.namespace));

export const buildExecuteToolDescription = (
  options: BuildExecuteToolDescriptionOptions,
): Effect.Effect<string, RuntimeAdapterError> =>
  Effect.gen(function* () {
    const namespaceLimit = Math.max(
      1,
      Math.min(maxNamespaceDescriptionRows, options.namespaceLimit ?? maxNamespaceDescriptionRows),
    );

    const namespacesOutput = yield* options.toolRegistry.catalogNamespaces({
      limit: namespaceLimit,
    });

    const namespaces = normalizeNamespaces(namespacesOutput.namespaces);

    if (options.mode === "sources_only") {
      return formatSourcesOnlyDescription(namespaces);
    }

    const requestedToolLimit = Math.max(
      1,
      Math.min(
        maxToolDescriptionRows,
        options.toolLimitPerNamespace ?? maxToolDescriptionRows,
      ),
    );

    const toolsByNamespace = yield* Effect.forEach(
      namespaces,
      (namespace) =>
        options.toolRegistry.catalogTools({
          namespace: namespace.namespace,
          limit: requestedToolLimit,
          compact: false,
          includeSchemas: false,
        }),
      {
        concurrency: 4,
      },
    );

    const tools = dedupeToolsByPath(
      toolsByNamespace.flatMap((result) => result.results),
    );

    return formatAllToolsDescription(namespaces, tools);
  });
