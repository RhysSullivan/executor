import type { Plugin } from "@executor/sdk";
import {
  mcpPlugin as _mcpPlugin,
  type McpSourceConfig,
  type McpProbeResult,
  type McpOAuthStartInput,
  type McpOAuthStartResponse,
  type McpOAuthCompleteInput,
  type McpOAuthCompleteResponse,
} from "./sdk/plugin";

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

export interface McpExtension {
  readonly probeEndpoint: (
    endpoint: string,
  ) => Promise<McpProbeResult>;
  readonly addSource: (
    config: McpSourceConfig,
  ) => Promise<{ readonly toolCount: number; readonly namespace: string }>;
  readonly removeSource: (namespace: string) => Promise<void>;
  readonly refreshSource: (
    namespace: string,
  ) => Promise<{ readonly toolCount: number }>;
  readonly startOAuth: (
    input: McpOAuthStartInput,
  ) => Promise<McpOAuthStartResponse>;
  readonly completeOAuth: (
    input: McpOAuthCompleteInput,
  ) => Promise<McpOAuthCompleteResponse>;
}

export const mcpPlugin: (options?: {}) => Plugin<"mcp", McpExtension> =
  _mcpPlugin as any;
