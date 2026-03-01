import {
  buildExecuteToolDescription,
  defaultExecuteToolDescription,
  defaultExecuteToolExposureMode,
  parseExecuteToolExposureMode,
  type ExecuteToolExposureMode,
} from "@executor-v2/engine";
import { handleMcpHttpRequest } from "@executor-v2/mcp-gateway";
import { createExecutorRunClient } from "@executor-v2/sdk";
import * as Effect from "effect/Effect";

import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { executeRunImpl } from "./executor";
import {
  getMcpAuthConfig,
  unauthorizedMcpResponse,
  verifyMcpToken,
} from "./mcp_auth";
import { createConvexSourceToolRegistry } from "./source_tool_registry";

const readConfiguredWorkspaceId = (value: string | undefined): string => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "ws_local";
};

const readWorkspaceIdFromRequest = (request: Request): string | null => {
  const value = new URL(request.url).searchParams.get("workspaceId")?.trim();
  return value && value.length > 0 ? value : null;
};

const readRequestedWorkspaceId = (request: Request, fallbackWorkspaceId: string): string =>
  readWorkspaceIdFromRequest(request) ?? fallbackWorkspaceId;

const readToolExposureModeFromRequest = (
  request: Request,
  fallbackMode: ExecuteToolExposureMode,
): ExecuteToolExposureMode => {
  const url = new URL(request.url);
  const rawMode =
    url.searchParams.get("toolExposureMode") ??
    url.searchParams.get("toolContextMode") ??
    undefined;

  return parseExecuteToolExposureMode(rawMode ?? undefined) ?? fallbackMode;
};

const resolveExecuteToolDescription = async (
  mode: ExecuteToolExposureMode,
  toolRegistry: ReturnType<typeof createConvexSourceToolRegistry>,
): Promise<string> => {
  try {
    return await Effect.runPromise(
      buildExecuteToolDescription({
        toolRegistry,
        mode,
      }),
    );
  } catch {
    return defaultExecuteToolDescription;
  }
};

const hasWorkspaceAccess = async (
  ctx: ActionCtx,
  workspaceId: string,
  accountId: string,
): Promise<boolean> => {
  try {
    const workspace = (await ctx.runQuery(
      runtimeInternal.control_plane.actor.getWorkspaceForActor,
      { workspaceId },
    )) as {
      organizationId: string;
      createdByAccountId: string | null;
    } | null;

    if (!workspace) {
      return false;
    }

    if (workspace.createdByAccountId === accountId) {
      return true;
    }

    const memberships = (await ctx.runQuery(
      runtimeInternal.control_plane.actor.listOrganizationMembershipsForActor,
      { accountId },
    )) as Array<{
      organizationId: string;
    }>;

    return memberships.some((membership) => membership.organizationId === workspace.organizationId);
  } catch {
    return false;
  }
};

const fallbackWorkspaceId = readConfiguredWorkspaceId(process.env.CONVEX_WORKSPACE_ID);
const defaultToolExposureMode =
  parseExecuteToolExposureMode(process.env.CONVEX_TOOL_EXPOSURE_MODE) ??
  defaultExecuteToolExposureMode;
const runtimeInternal = internal as any;

export const mcpHandler = httpAction(async (ctx, request) => {
  const mcpAuthConfig = getMcpAuthConfig();
  const requestWorkspaceId = readWorkspaceIdFromRequest(request);
  const workspaceId = readRequestedWorkspaceId(request, fallbackWorkspaceId);

  if (!mcpAuthConfig.enabled) {
    if (mcpAuthConfig.required) {
      return Response.json(
        {
          error: "MCP OAuth must be configured for cloud deployments",
        },
        { status: 503 },
      );
    }
  } else {
    const auth = await verifyMcpToken(request, mcpAuthConfig);
    if (!auth) {
      return unauthorizedMcpResponse(request, "No valid bearer token provided.");
    }

    if (!requestWorkspaceId) {
      return Response.json(
        {
          error: "workspaceId query parameter is required when MCP OAuth is enabled",
        },
        { status: 400 },
      );
    }

    const authorized = await hasWorkspaceAccess(ctx, requestWorkspaceId, auth.subject);
    if (!authorized) {
      return Response.json(
        {
          error: "Workspace authorization failed",
        },
        { status: 403 },
      );
    }
  }

  const toolRegistry = createConvexSourceToolRegistry(ctx, workspaceId);
  const toolExposureMode = readToolExposureModeFromRequest(
    request,
    defaultToolExposureMode,
  );
  const executeToolDescription = await resolveExecuteToolDescription(
    toolExposureMode,
    toolRegistry,
  );

  const runClient = createExecutorRunClient(async (input) => {
    const runId = `run_${crypto.randomUUID()}`;

    await ctx.runMutation(runtimeInternal.task_runs.startTaskRun, {
      workspaceId,
      runId,
      sessionId: "session_mcp",
      runtimeId: "runtime_local_inproc",
      codeHash: `code_length_${input.code.length}`,
    });

    try {
      const result = await Effect.runPromise(
        executeRunImpl(input, {
          toolRegistry,
          makeRunId: () => runId,
        }),
      );

      await ctx.runMutation(runtimeInternal.task_runs.finishTaskRun, {
        workspaceId,
        runId,
        status: result.status,
        error: result.error ?? null,
      });

      return result;
    } catch (cause) {
      await ctx.runMutation(runtimeInternal.task_runs.finishTaskRun, {
        workspaceId,
        runId,
        status: "failed",
        error: String(cause),
      });
      throw cause;
    }
  });

  return handleMcpHttpRequest(request, {
    serverName: "executor-v2-convex",
    serverVersion: "0.0.0",
    runClient,
    executeToolDescription,
  });
});
