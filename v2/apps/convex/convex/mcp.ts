import { handleMcpHttpRequest } from "@executor-v2/mcp-gateway";
import { createExecutorRunClient } from "@executor-v2/sdk";
import * as Effect from "effect/Effect";

import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { executeRunImpl } from "./executor";

export const mcpHandler = httpAction(async (ctx, request) => {
  const runClient = createExecutorRunClient((input) =>
    Effect.runPromise(executeRunImpl(input)),
  );

  return handleMcpHttpRequest(request, {
    target: "remote",
    serverName: "executor-v2-convex",
    serverVersion: "0.0.0",
    runClient,
    sourceControl: {
      listSources: (input) =>
        ctx.runQuery(api.controlPlane.listSources, {
          workspaceId: input.workspaceId,
        }),
      upsertSource: (input) =>
        ctx.runMutation(api.controlPlane.upsertSource, {
          workspaceId: input.workspaceId,
          payload: input.payload,
        }),
      removeSource: (input) =>
        ctx.runMutation(api.controlPlane.removeSource, {
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
        }),
    },
  });
});
