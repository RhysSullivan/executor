import type { ToolApprovalMode } from "../types";

export interface McpToolSourceConfig {
  type: "mcp";
  name: string;
  sourceId?: string;
  sourceKey?: string;
  url: string;
  auth?: OpenApiAuth;
  discoveryHeaders?: Record<string, string>;
  transport?: "sse" | "streamable-http";
  queryParams?: Record<string, string>;
  defaultApproval?: ToolApprovalMode;
  overrides?: Record<string, { approval?: ToolApprovalMode }>;
}

export type OpenApiAuth =
  | { type: "none" }
  | { type: "basic"; mode?: "static" | "account" | "workspace" | "organization"; username?: string; password?: string }
  | { type: "bearer"; mode?: "static" | "account" | "workspace" | "organization"; token?: string }
  | { type: "apiKey"; mode?: "static" | "account" | "workspace" | "organization"; header: string; value?: string };

export interface OpenApiToolSourceConfig {
  type: "openapi";
  name: string;
  sourceId?: string;
  sourceKey?: string;
  spec: string | Record<string, unknown>;
  collectionUrl?: string;
  postmanProxyUrl?: string;
  baseUrl?: string;
  auth?: OpenApiAuth;
  defaultReadApproval?: ToolApprovalMode;
  defaultWriteApproval?: ToolApprovalMode;
  overrides?: Record<string, { approval?: ToolApprovalMode }>;
}

export interface GraphqlToolSourceConfig {
  type: "graphql";
  name: string;
  sourceId?: string;
  sourceKey?: string;
  endpoint: string;
  schema?: Record<string, unknown>;
  auth?: OpenApiAuth;
  defaultQueryApproval?: ToolApprovalMode;
  defaultMutationApproval?: ToolApprovalMode;
  overrides?: Record<string, { approval?: ToolApprovalMode }>;
}

export type ExternalToolSourceConfig =
  | McpToolSourceConfig
  | OpenApiToolSourceConfig
  | GraphqlToolSourceConfig;

export interface PreparedOpenApiSpec {
  servers: string[];
  paths: Record<string, unknown>;
  refHintTable?: Record<string, string>;
  dts?: string;
  dtsStatus?: "ready" | "failed" | "skipped";
  inferredAuth?: OpenApiAuth;
  warnings: string[];
}
