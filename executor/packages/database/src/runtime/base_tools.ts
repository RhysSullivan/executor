import type { ToolDefinition } from "../../../core/src/types";
import {
  catalogNamespacesInputJsonSchema,
  catalogNamespacesOutputJsonSchema,
  catalogToolsInputJsonSchema,
  catalogToolsOutputJsonSchema,
  discoverInputJsonSchema,
  discoverOutputJsonSchema,
} from "./discovery_tool_contracts";

export const baseTools = new Map<string, ToolDefinition>();

// Built-in system tools are resolved server-side.
// Their execution is handled in the Convex tool invocation pipeline.
baseTools.set("discover", {
  path: "discover",
  source: "system",
  approval: "auto",
  description:
    "Search available tools by keyword. Returns preferred path aliases, signature hints, and typing schemas for precise calls.",
  typing: {
    inputSchema: discoverInputJsonSchema,
    outputSchema: discoverOutputJsonSchema,
  },
  run: async () => {
    throw new Error("discover is handled by the server tool invocation pipeline");
  },
});

baseTools.set("catalog.namespaces", {
  path: "catalog.namespaces",
  source: "system",
  approval: "auto",
  description: "List available tool namespaces with counts and sample callable paths.",
  typing: {
    inputSchema: catalogNamespacesInputJsonSchema,
    outputSchema: catalogNamespacesOutputJsonSchema,
  },
  run: async () => {
    throw new Error("catalog.namespaces is handled by the server tool invocation pipeline");
  },
});

baseTools.set("catalog.tools", {
  path: "catalog.tools",
  source: "system",
  approval: "auto",
  description: "List tools with typed signatures and input/output JSON Schemas. Supports namespace and query filters.",
  typing: {
    inputSchema: catalogToolsInputJsonSchema,
    outputSchema: catalogToolsOutputJsonSchema,
  },
  run: async () => {
    throw new Error("catalog.tools is handled by the server tool invocation pipeline");
  },
});
