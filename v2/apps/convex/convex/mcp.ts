import { handleMcpHttpRequest } from "@executor-v2/mcp-gateway";
import { httpAction } from "./_generated/server";

export const mcpHandler = httpAction(async (_ctx, request) =>
  handleMcpHttpRequest(request, {
    target: "remote",
    serverName: "executor-v2-convex",
    serverVersion: "0.0.0",
    execute: async () => ({
      isError: true,
      error: "Remote execute path is not wired yet",
    }),
  }));
