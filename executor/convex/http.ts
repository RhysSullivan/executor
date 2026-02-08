import { registerRoutes as registerStripeRoutes } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import { api, components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authKit } from "./auth";
import { handleMcpRequest, type McpWorkspaceContext } from "./lib/mcp-server";
import type { AnonymousContext, TaskRecord, ToolDescriptor } from "./lib/types";

const http = httpRouter();
const internalToken = process.env.EXECUTOR_INTERNAL_TOKEN ?? "executor_internal_local_dev_token";

function parseMcpContext(url: URL): McpWorkspaceContext | undefined {
  const workspaceId = url.searchParams.get("workspaceId");
  const actorId = url.searchParams.get("actorId");
  if (!workspaceId || !actorId) return undefined;
  const clientId = url.searchParams.get("clientId") ?? undefined;
  return { workspaceId, actorId, clientId };
}

function isInternalAuthorized(request: Request): boolean {
  if (!internalToken) return true;
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === internalToken;
}

function parseInternalRunPath(pathname: string): { runId: string; endpoint: "tool-call" | "output" } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "internal" || parts[1] !== "runs") {
    return null;
  }

  const runId = parts[2];
  const endpoint = parts[3];
  if (!runId || (endpoint !== "tool-call" && endpoint !== "output")) {
    return null;
  }

  return { runId, endpoint };
}

const mcpHandler = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const context = parseMcpContext(url);

  const service = {
    createTask: async (input: {
      code: string;
      timeoutMs?: number;
      runtimeId?: string;
      metadata?: Record<string, unknown>;
      workspaceId: string;
      actorId: string;
      clientId?: string;
    }) => {
      return (await ctx.runMutation(api.executor.createTask, input)) as { task: TaskRecord };
    },
    getTask: async (taskId: string, workspaceId?: string) => {
      if (workspaceId) {
        return (await ctx.runQuery(api.database.getTaskInWorkspace, { taskId, workspaceId })) as TaskRecord | null;
      }
      return (await ctx.runQuery(api.database.getTask, { taskId })) as TaskRecord | null;
    },
    subscribe: () => {
      return () => {};
    },
    bootstrapAnonymousContext: async (sessionId?: string) => {
      return (await ctx.runMutation(api.database.bootstrapAnonymousSession, { sessionId })) as AnonymousContext;
    },
    listTools: async (toolContext?: { workspaceId: string; actorId?: string; clientId?: string }) => {
      return (await ctx.runAction(api.executorNode.listTools, toolContext ?? {})) as ToolDescriptor[];
    },
  };

  return await handleMcpRequest(service, request, context);
});

const internalRunsHandler = httpAction(async (ctx, request) => {
  if (!isInternalAuthorized(request)) {
    return Response.json({ error: "Unauthorized internal call" }, { status: 401 });
  }

  const url = new URL(request.url);
  const parsed = parseInternalRunPath(url.pathname);
  if (!parsed) {
    return Response.json({ error: "Invalid internal route" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  if (parsed.endpoint === "tool-call") {
    const callId = payload.callId;
    const toolPath = payload.toolPath;
    if (typeof callId !== "string" || typeof toolPath !== "string") {
      return Response.json({ error: "callId and toolPath are required" }, { status: 400 });
    }

    const result = await ctx.runAction(internal.executorNode.handleExternalToolCall, {
      runId: parsed.runId,
      callId,
      toolPath,
      input: payload.input,
    });
    return Response.json(result, { status: 200 });
  }

  const stream = payload.stream;
  const line = payload.line;
  if ((stream !== "stdout" && stream !== "stderr") || typeof line !== "string") {
    return Response.json({ error: "stream and line are required" }, { status: 400 });
  }

  const task = await ctx.runQuery(api.database.getTask, { taskId: parsed.runId });
  if (!task) {
    return Response.json({ error: `Run not found: ${parsed.runId}` }, { status: 404 });
  }

  await ctx.runMutation(internal.executor.appendRuntimeOutput, {
    runId: parsed.runId,
    stream,
    line,
    timestamp: typeof payload.timestamp === "number" ? payload.timestamp : Date.now(),
  });

  return Response.json({ ok: true }, { status: 200 });
});

authKit.registerRoutes(http);
registerStripeRoutes(http, components.stripe, {
  webhookPath: "/stripe/webhook",
});

http.route({ path: "/mcp", method: "POST", handler: mcpHandler });
http.route({ path: "/mcp", method: "GET", handler: mcpHandler });
http.route({ path: "/mcp", method: "DELETE", handler: mcpHandler });

http.route({
  pathPrefix: "/internal/runs/",
  method: "POST",
  handler: internalRunsHandler,
});

export default http;
