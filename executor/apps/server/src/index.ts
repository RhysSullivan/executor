import { Elysia, t } from "elysia";
import { ExecutorDatabase } from "./database";
import { TaskEventHub } from "./events";
import { handleMcpRequest, type McpWorkspaceContext } from "./mcp-server";
import { LocalBunRuntime } from "./runtimes/local-bun-runtime";
import { VercelSandboxRuntime } from "./runtimes/vercel-sandbox-runtime";
import { ExecutorService, getTaskTerminalState } from "./service";
import { ensureTailscaleFunnel } from "./tailscale-funnel";
import { loadExternalTools, parseToolSourcesFromEnv } from "./tool-sources";
import { DEFAULT_TOOLS } from "./tools";
import type {
  ApprovalStatus,
  TaskStatus,
  ToolCallRequest,
  RuntimeOutputEvent,
} from "./types";

// ── Bootstrap ──

const port = Number(Bun.env.PORT ?? "4001");
const autoFunnelEnabled = Bun.env.EXECUTOR_AUTO_TAILSCALE_FUNNEL !== "0";
const explicitInternalBaseUrl = Bun.env.EXECUTOR_INTERNAL_BASE_URL ?? Bun.env.EXECUTOR_PUBLIC_BASE_URL;
const generatedInternalToken = Bun.env.EXECUTOR_INTERNAL_TOKEN ?? "executor_internal_local_dev_token";
const internalToken = generatedInternalToken;

let internalBaseUrl = explicitInternalBaseUrl ?? `http://127.0.0.1:${port}`;
let internalBaseSource = explicitInternalBaseUrl ? "env" : "localhost-default";

if (!explicitInternalBaseUrl && autoFunnelEnabled) {
  try {
    const funnel = ensureTailscaleFunnel(port);
    internalBaseUrl = funnel.url;
    internalBaseSource = funnel.created ? "tailscale-funnel-created" : "tailscale-funnel-existing";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] tailscale funnel unavailable, using localhost callbacks: ${message}`);
  }
}

const toolSourceConfigs = (() => {
  try {
    return parseToolSourcesFromEnv(Bun.env.EXECUTOR_TOOL_SOURCES);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[executor] invalid EXECUTOR_TOOL_SOURCES: ${message}`);
    return [];
  }
})();

const { tools: externalTools, warnings: externalToolWarnings } = await loadExternalTools(toolSourceConfigs);
if (externalToolWarnings.length > 0) {
  for (const w of externalToolWarnings) console.warn(`[executor] ${w}`);
}
const tools = [...DEFAULT_TOOLS, ...externalTools];

const service = new ExecutorService(new ExecutorDatabase(), new TaskEventHub(), [
  new LocalBunRuntime(),
  new VercelSandboxRuntime({
    controlPlaneBaseUrl: internalBaseUrl,
    internalToken,
    runtime: Bun.env.EXECUTOR_VERCEL_SANDBOX_RUNTIME as "node24" | "node22" | undefined,
  }),
], tools, {
  autoExecuteTasks: Bun.env.EXECUTOR_SERVER_AUTO_EXECUTE === "1",
});

// ── SSE helper ──

function createTaskEventsResponse(taskId: string): Response | Promise<Response> {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const task = await service.getTask(taskId);
        if (!task) {
          controller.close();
          return;
        }

        const replay = await service.listTaskEvents(taskId);
        for (const event of replay) {
          const frame = `event: ${event.eventName}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        }

        if (getTaskTerminalState(task.status)) {
          controller.close();
          return;
        }

        unsubscribe = service.subscribe(taskId, (event) => {
          try {
            const frame = `event: ${event.eventName}\ndata: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(frame));

            if (
              event.eventName === "task" &&
              typeof event.payload === "object" &&
              event.payload !== null &&
              "status" in event.payload
            ) {
              const status = String((event.payload as { status?: unknown }).status ?? "") as TaskStatus;
              if (getTaskTerminalState(status)) {
                if (keepalive) clearInterval(keepalive);
                if (unsubscribe) unsubscribe();
                controller.close();
              }
            }
          } catch {
            if (keepalive) clearInterval(keepalive);
            if (unsubscribe) unsubscribe();
            controller.close();
          }
        });

        keepalive = setInterval(() => {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15_000);
      })().catch(() => {
        if (keepalive) clearInterval(keepalive);
        if (unsubscribe) unsubscribe();
        controller.close();
      });
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

// ── Internal auth guard ──

function isInternalAuthorized(request: Request): boolean {
  if (!internalToken) return true;
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === internalToken;
}

function parseMcpContext(url: URL): McpWorkspaceContext | undefined {
  const workspaceId = url.searchParams.get("workspaceId");
  const actorId = url.searchParams.get("actorId");
  if (!workspaceId || !actorId) return undefined;
  const clientId = url.searchParams.get("clientId") ?? undefined;
  return { workspaceId, actorId, clientId };
}

// ── Elysia app ──

const app = new Elysia()
  // CORS
  .onRequest(({ set }) => {
    set.headers["access-control-allow-origin"] = "*";
    set.headers["access-control-allow-methods"] = "GET,POST,DELETE,OPTIONS";
    set.headers["access-control-allow-headers"] = "content-type,authorization";
  })
  .options("/*", () => new Response(null, { status: 204 }))

  // ── MCP (raw protocol passthrough) ──
  // Optional query params: ?workspaceId=...&actorId=... to bind workspace context.
  // When bound, run_code description includes sandbox tool inventory and input is simplified.
  .post("/mcp", async ({ request }) => {
    const url = new URL(request.url);
    const context = parseMcpContext(url);
    return await handleMcpRequest(service, request, context);
  })
  .get("/mcp", async ({ request }) => {
    const url = new URL(request.url);
    const context = parseMcpContext(url);
    return await handleMcpRequest(service, request, context);
  })
  .delete("/mcp", async ({ request }) => {
    const url = new URL(request.url);
    const context = parseMcpContext(url);
    return await handleMcpRequest(service, request, context);
  })

  // ── Health ──
  .get("/api/health", () => ({
    ok: true as const,
    tools: service.getBaseToolCount(),
  }))

  // ── Auth ──
  .post("/api/auth/anonymous/bootstrap", async ({ body }) => {
    return await service.bootstrapAnonymousContext(body.sessionId);
  }, {
    body: t.Object({
      sessionId: t.Optional(t.String()),
    }),
  })

  // ── Runtime Targets ──
  .get("/api/runtime-targets", () => service.listRuntimes())

  // ── Tools ──
  .get("/api/tools", async ({ query, set }) => {
    if (!query.workspaceId) {
      set.status = 400;
      return { error: "workspaceId is required" };
    }
    return await service.listTools({
      workspaceId: query.workspaceId,
      actorId: query.actorId,
      clientId: query.clientId,
    });
  }, {
    query: t.Object({
      workspaceId: t.String(),
      actorId: t.Optional(t.String()),
      clientId: t.Optional(t.String()),
    }),
  })

  // ── Tool Sources ──
  .get("/api/tool-sources", async ({ query, set }) => {
    if (!query.workspaceId) {
      set.status = 400;
      return { error: "workspaceId is required" };
    }
    return await service.listToolSources(query.workspaceId);
  }, {
    query: t.Object({
      workspaceId: t.String(),
    }),
  })

  .post("/api/tool-sources", async ({ body, set }) => {
    if (!body.workspaceId || !body.name || !body.type || !body.config) {
      set.status = 400;
      return { error: "workspaceId, name, type, and config are required" };
    }
    try {
      return await service.upsertToolSource({
        id: body.id,
        workspaceId: body.workspaceId,
        name: body.name,
        type: body.type,
        config: body.config,
        enabled: body.enabled,
      });
    } catch (cause) {
      set.status = 400;
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, {
    body: t.Object({
      id: t.Optional(t.String()),
      workspaceId: t.String(),
      name: t.String(),
      type: t.Union([t.Literal("mcp"), t.Literal("openapi"), t.Literal("graphql")]),
      config: t.Record(t.String(), t.Unknown()),
      enabled: t.Optional(t.Boolean()),
    }),
  })

  .delete("/api/tool-sources/:sourceId", async ({ params, query, set }) => {
    if (!query.workspaceId) {
      set.status = 400;
      return { error: "workspaceId is required" };
    }
    const deleted = await service.deleteToolSource(query.workspaceId, params.sourceId);
    if (!deleted) {
      set.status = 404;
      return { error: "Tool source not found" };
    }
    return { ok: true as const };
  }, {
    params: t.Object({ sourceId: t.String() }),
    query: t.Object({ workspaceId: t.String() }),
  })

  // ── Tasks ──
  .get("/api/tasks", async ({ query, set }) => {
    if (!query.workspaceId) {
      set.status = 400;
      return { error: "workspaceId is required" };
    }
    return await service.listTasks(query.workspaceId);
  }, {
    query: t.Object({ workspaceId: t.String() }),
  })

  .post("/api/tasks", async ({ body, set }) => {
    try {
      const created = await service.createTask(body);
      return { taskId: created.task.id, status: created.task.status };
    } catch (cause) {
      set.status = 400;
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, {
    body: t.Object({
      code: t.String(),
      timeoutMs: t.Optional(t.Number()),
      runtimeId: t.Optional(t.String()),
      metadata: t.Optional(t.Record(t.String(), t.Unknown())),
      workspaceId: t.String(),
      actorId: t.String(),
      clientId: t.Optional(t.String()),
    }),
  })

  .get("/api/tasks/:taskId", async ({ params, query, set }) => {
    if (!query.workspaceId) {
      set.status = 400;
      return { error: "workspaceId is required" };
    }
    const task = await service.getTask(params.taskId, query.workspaceId);
    if (!task) {
      set.status = 404;
      return { error: "Task not found" };
    }
    return task;
  }, {
    params: t.Object({ taskId: t.String() }),
    query: t.Object({ workspaceId: t.String() }),
  })

  .get("/api/tasks/:taskId/events", async ({ params, query, set }) => {
    if (!query.workspaceId) {
      set.status = 400;
      return { error: "workspaceId is required" };
    }
    const task = await service.getTask(params.taskId, query.workspaceId);
    if (!task) {
      set.status = 404;
      return { error: "Task not found" };
    }
    return createTaskEventsResponse(params.taskId);
  }, {
    params: t.Object({ taskId: t.String() }),
    query: t.Object({ workspaceId: t.String() }),
  })

  // ── Approvals ──
  .get("/api/approvals", async ({ query, set }) => {
    if (!query.workspaceId) {
      set.status = 400;
      return { error: "workspaceId is required" };
    }
    const status = query.status as ApprovalStatus | undefined;

    if (status === "pending") {
      return await service.listPendingApprovals(query.workspaceId);
    }

    if (status && status !== "approved" && status !== "denied") {
      set.status = 400;
      return { error: "Invalid approval status" };
    }

    return await service.listApprovals(query.workspaceId, status ?? undefined);
  }, {
    query: t.Object({
      workspaceId: t.String(),
      status: t.Optional(t.String()),
    }),
  })

  .post("/api/approvals/:approvalId", async ({ params, body, set }) => {
    if (!body.workspaceId || (body.decision !== "approved" && body.decision !== "denied")) {
      set.status = 400;
      return { error: "workspaceId and decision are required" };
    }

    const resolved = await service.resolveApproval(
      body.workspaceId,
      params.approvalId,
      body.decision,
      body.reviewerId,
      body.reason,
    );

    if (!resolved) {
      set.status = 404;
      return { error: "Approval not found or already resolved" };
    }
    return resolved;
  }, {
    params: t.Object({ approvalId: t.String() }),
    body: t.Object({
      workspaceId: t.String(),
      decision: t.Union([t.Literal("approved"), t.Literal("denied")]),
      reviewerId: t.Optional(t.String()),
      reason: t.Optional(t.String()),
    }),
  })

  // ── Policies ──
  .get("/api/policies", async ({ query, set }) => {
    if (!query.workspaceId) {
      set.status = 400;
      return { error: "workspaceId is required" };
    }
    return await service.listAccessPolicies(query.workspaceId);
  }, {
    query: t.Object({ workspaceId: t.String() }),
  })

  .post("/api/policies", async ({ body, set }) => {
    if (!body.workspaceId || !body.toolPathPattern || !body.decision) {
      set.status = 400;
      return { error: "workspaceId, toolPathPattern, and decision are required" };
    }
    return await service.upsertAccessPolicy({
      id: body.id,
      workspaceId: body.workspaceId,
      actorId: body.actorId,
      clientId: body.clientId,
      toolPathPattern: body.toolPathPattern,
      decision: body.decision,
      priority: body.priority,
    });
  }, {
    body: t.Object({
      id: t.Optional(t.String()),
      workspaceId: t.String(),
      actorId: t.Optional(t.String()),
      clientId: t.Optional(t.String()),
      toolPathPattern: t.String(),
      decision: t.Union([t.Literal("allow"), t.Literal("require_approval"), t.Literal("deny")]),
      priority: t.Optional(t.Number()),
    }),
  })

  // ── Credentials ──
  .get("/api/credentials", async ({ query, set }) => {
    if (!query.workspaceId) {
      set.status = 400;
      return { error: "workspaceId is required" };
    }
    return await service.listCredentials(query.workspaceId);
  }, {
    query: t.Object({ workspaceId: t.String() }),
  })

  .post("/api/credentials", async ({ body, set }) => {
    if (!body.workspaceId || !body.sourceKey || !body.scope || !body.secretJson) {
      set.status = 400;
      return { error: "workspaceId, sourceKey, scope, and secretJson are required" };
    }
    if (body.scope === "actor" && (!body.actorId || body.actorId.trim().length === 0)) {
      set.status = 400;
      return { error: "actorId is required for actor-scoped credential" };
    }

    const credential = await service.upsertCredential({
      id: body.id,
      workspaceId: body.workspaceId,
      sourceKey: body.sourceKey,
      scope: body.scope,
      actorId: body.actorId,
      secretJson: body.secretJson,
    });

    return {
      id: credential.id,
      workspaceId: credential.workspaceId,
      sourceKey: credential.sourceKey,
      scope: credential.scope,
      actorId: credential.actorId,
      hasSecret: true as const,
    };
  }, {
    body: t.Object({
      id: t.Optional(t.String()),
      workspaceId: t.String(),
      sourceKey: t.String(),
      scope: t.Union([t.Literal("workspace"), t.Literal("actor")]),
      actorId: t.Optional(t.String()),
      secretJson: t.Record(t.String(), t.Unknown()),
    }),
  })

  // ── Internal endpoints (bearer auth protected) ──
  .post("/internal/runs/:runId/tool-call", async ({ params, body, request, set }) => {
    if (!isInternalAuthorized(request)) {
      set.status = 401;
      return { error: "Unauthorized internal call" };
    }
    if (!body.callId || !body.toolPath) {
      set.status = 400;
      return { error: "callId and toolPath are required" };
    }

    const call: ToolCallRequest = {
      runId: params.runId,
      callId: body.callId,
      toolPath: body.toolPath,
      input: body.input,
    };

    return await service.handleExternalToolCall(call);
  }, {
    params: t.Object({ runId: t.String() }),
    body: t.Object({
      callId: t.String(),
      toolPath: t.String(),
      input: t.Optional(t.Unknown()),
    }),
  })

  .post("/internal/runs/:runId/output", async ({ params, body, request, set }) => {
    if (!isInternalAuthorized(request)) {
      set.status = 401;
      return { error: "Unauthorized internal call" };
    }

    const event: RuntimeOutputEvent = {
      runId: params.runId,
      stream: body.stream,
      line: body.line,
      timestamp: typeof body.timestamp === "number" ? body.timestamp : Date.now(),
    };

    const task = await service.getTask(event.runId);
    if (!task) {
      set.status = 404;
      return { error: `Run not found: ${event.runId}` };
    }

    await service.appendRuntimeOutput(event);
    return { ok: true as const };
  }, {
    params: t.Object({ runId: t.String() }),
    body: t.Object({
      stream: t.Union([t.Literal("stdout"), t.Literal("stderr")]),
      line: t.String(),
      timestamp: t.Optional(t.Number()),
    }),
  })

  .listen(port);

export type App = typeof app;

console.log(`executor server listening on http://localhost:${app.server!.port}`);
console.log(`[executor] internal callback base: ${internalBaseUrl} (${internalBaseSource})`);
console.log(`[executor] internal callback auth token enabled: yes`);
console.log(`[executor] tools loaded: ${tools.length} (${externalTools.length} external)`);
console.log(`[executor] server auto execute enabled: ${Bun.env.EXECUTOR_SERVER_AUTO_EXECUTE === "1" ? "yes" : "no"}`);
