import { handleMcpHttpRequest } from "@executor-v2/mcp-gateway";
import { createExecutorRunClient } from "@executor-v2/sdk";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { unwrapRpcSuccess } from "./rpc_exit";
export const mcpHandler = httpAction(async (ctx, request) => {
  const runClient = createExecutorRunClient((input) =>
    ctx
      .runAction(api.executor.executeRun, input)
      .then((result) => unwrapRpcSuccess(result, "executor.executeRun")),
  );

  return handleMcpHttpRequest(request, {
    target: "remote",
    serverName: "executor-v2-convex",
    serverVersion: "0.0.0",
    runClient,
  });
});
