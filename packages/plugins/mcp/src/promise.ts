import { mcpPlugin as mcpPluginEffect } from "./sdk/plugin";

export type {
  McpSourceConfig,
  McpRemoteSourceConfig,
  McpStdioSourceConfig,
  McpProbeResult,
  McpOAuthStartInput,
  McpOAuthStartResponse,
  McpOAuthCompleteInput,
  McpOAuthCompleteResponse,
} from "./sdk/plugin";

export type { McpBindingStore } from "./sdk/binding-store";

export type McpPluginOptions = Record<string, never>;

export const mcpPlugin = (_options?: McpPluginOptions) => mcpPluginEffect();
