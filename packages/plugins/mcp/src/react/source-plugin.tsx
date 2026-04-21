import { lazy, type ComponentProps, type ComponentType } from "react";
import type { SourcePlugin } from "@executor/react/plugins/source-plugin";
import { mcpPresets } from "../sdk/presets";

const LazyAddMcpSource = lazy(() => import("./AddMcpSource"));
const LazyEditMcpSource = lazy(() => import("./EditMcpSource"));
const LazySummary = lazy(() => import("./McpSourceSummary"));
const LazyMcpSignInButton = lazy(() => import("./McpSignInButton"));

type AddProps = ComponentProps<SourcePlugin["add"]>;

export interface McpSourcePluginOptions {
  /**
   * Enable the stdio transport in the add-source UI (tab + presets).
   *
   * Off by default — stdio is a high-risk transport on any server deployment
   * (see `dangerouslyAllowStdioMCP` on the server-side plugin). Only enable in
   * trusted local contexts where the server has the matching flag set.
   */
  readonly allowStdio?: boolean;
}

export const createMcpSourcePlugin = (
  options?: McpSourcePluginOptions,
): SourcePlugin => {
  const allowStdio = options?.allowStdio ?? false;

  const AddWithFlag: ComponentType<AddProps> = (props) => (
    <LazyAddMcpSource {...props} allowStdio={allowStdio} />
  );

  const presets = allowStdio
    ? mcpPresets
    : mcpPresets.filter(
        (p) => !("transport" in p && (p as { transport?: string }).transport === "stdio"),
      );

  return {
    key: "mcp",
    label: "MCP",
    add: AddWithFlag,
    edit: LazyEditMcpSource,
    summary: LazySummary,
    signIn: LazyMcpSignInButton,
    presets,
  };
};

/** @deprecated Use `createMcpSourcePlugin({ allowStdio })` instead. */
export const mcpSourcePlugin: SourcePlugin = createMcpSourcePlugin();
