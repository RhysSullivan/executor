import { ExecutorDatabase } from "./database";
import { TaskEventHub } from "./events";
import { LocalBunRuntime } from "./runtimes/local-bun-runtime";
import { VercelSandboxRuntime } from "./runtimes/vercel-sandbox-runtime";
import { ExecutorService, getTaskTerminalState } from "./service";
import { ensureTailscaleFunnel } from "./tailscale-funnel";
import { loadExternalTools, parseToolSourcesFromEnv } from "./tool-sources";
import { DEFAULT_TOOLS } from "./tools";
import type {
  ApprovalStatus,
  CredentialScope,
  CreateTaskInput,
  PendingApprovalRecord,
  PolicyDecision,
  TaskStatus,
  ToolCallRequest,
  RuntimeOutputEvent,
} from "./types";

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

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders,
  });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

function isInternalAuthorized(request: Request): boolean {
  if (!internalToken) {
    return true;
  }

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return false;
  }

  return header.slice("Bearer ".length) === internalToken;
}

async function parseBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function createTaskEventsResponse(taskId: string): Promise<Response> {
  const task = await service.getTask(taskId);
  if (!task) {
    return error(404, "Task not found");
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
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

const server = Bun.serve({
  port,
  routes: {
    "/api/health": {
      GET: () => json({ ok: true, tools: service.getBaseToolCount() }),
    },
    "/api/auth/anonymous/bootstrap": {
      POST: async (request) => {
        const body = await parseBody<{ sessionId?: string }>(request);
        const context = await service.bootstrapAnonymousContext(body?.sessionId);
        return json(context, 201);
      },
    },
    "/api/runtime-targets": {
      GET: () => json(service.listRuntimes()),
    },
    "/api/tools": {
      GET: async (request) => {
        const query = new URL(request.url).searchParams;
        const workspaceId = query.get("workspaceId");
        const actorId = query.get("actorId") ?? undefined;
        const clientId = query.get("clientId") ?? undefined;

        if (!workspaceId) {
          return error(400, "workspaceId is required");
        }

        return json(await service.listTools({ workspaceId, actorId, clientId }));
      },
    },
    "/api/tool-sources": {
      GET: async (request) => {
        const workspaceId = new URL(request.url).searchParams.get("workspaceId");
        if (!workspaceId) {
          return error(400, "workspaceId is required");
        }
        return json(await service.listToolSources(workspaceId));
      },
      POST: async (request) => {
        const body = await parseBody<{
          id?: string;
          workspaceId?: string;
          name?: string;
          type?: "mcp" | "openapi" | "graphql";
          config?: Record<string, unknown>;
          enabled?: boolean;
        }>(request);

        if (!body || !body.workspaceId || !body.name || !body.type || !body.config) {
          return error(400, "workspaceId, name, type, and config are required");
        }

        if (body.type !== "mcp" && body.type !== "openapi" && body.type !== "graphql") {
          return error(400, "type must be 'mcp', 'openapi', or 'graphql'");
        }

        try {
          const source = await service.upsertToolSource({
            id: body.id,
            workspaceId: body.workspaceId,
            name: body.name,
            type: body.type,
            config: body.config,
            enabled: body.enabled,
          });
          return json(source, body.id ? 200 : 201);
        } catch (cause) {
          return error(400, cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    "/api/tool-sources/:sourceId": {
      DELETE: async (request) => {
        const workspaceId = new URL(request.url).searchParams.get("workspaceId");
        if (!workspaceId) {
          return error(400, "workspaceId is required");
        }

        const deleted = await service.deleteToolSource(workspaceId, request.params.sourceId);
        if (!deleted) {
          return error(404, "Tool source not found");
        }
        return json({ ok: true });
      },
    },
    "/api/tasks": {
      GET: async (request) => {
        const workspaceId = new URL(request.url).searchParams.get("workspaceId");
        if (!workspaceId) {
          return error(400, "workspaceId is required");
        }
        return json(await service.listTasks(workspaceId));
      },
      POST: async (request) => {
        const body = await parseBody<CreateTaskInput>(request);
        if (!body) {
          return error(400, "Invalid JSON body");
        }

        try {
          const created = await service.createTask(body);
          return json({ taskId: created.task.id, status: created.task.status }, 201);
        } catch (cause) {
          return error(400, cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
    "/api/tasks/:taskId": {
      GET: async (request) => {
        const workspaceId = new URL(request.url).searchParams.get("workspaceId");
        if (!workspaceId) {
          return error(400, "workspaceId is required");
        }

        const task = await service.getTask(request.params.taskId, workspaceId);
        if (!task) {
          return error(404, "Task not found");
        }
        return json(task);
      },
    },
    "/api/tasks/:taskId/events": {
      GET: async (request) => {
        const workspaceId = new URL(request.url).searchParams.get("workspaceId");
        if (!workspaceId) {
          return error(400, "workspaceId is required");
        }

        const task = await service.getTask(request.params.taskId, workspaceId);
        if (!task) {
          return error(404, "Task not found");
        }
        return await createTaskEventsResponse(request.params.taskId);
      },
    },
    "/api/approvals": {
      GET: async (request) => {
        const query = new URL(request.url).searchParams;
        const workspaceId = query.get("workspaceId");
        if (!workspaceId) {
          return error(400, "workspaceId is required");
        }
        const status = query.get("status") as ApprovalStatus | null;

        if (status === "pending") {
          return json((await service.listPendingApprovals(workspaceId)) satisfies PendingApprovalRecord[]);
        }

        if (status && status !== "approved" && status !== "denied") {
          return error(400, "Invalid approval status");
        }

        return json(await service.listApprovals(workspaceId, status ?? undefined));
      },
    },
    "/api/approvals/:approvalId": {
      POST: async (request) => {
        const body = await parseBody<{
          workspaceId?: string;
          decision?: "approved" | "denied";
          reviewerId?: string;
          reason?: string;
        }>(request);

        if (!body || !body.workspaceId || (body.decision !== "approved" && body.decision !== "denied")) {
          return error(400, "workspaceId and decision are required");
        }

        const resolved = await service.resolveApproval(
          body.workspaceId,
          request.params.approvalId,
          body.decision,
          body.reviewerId,
          body.reason,
        );

        if (!resolved) {
          return error(404, "Approval not found or already resolved");
        }

        return json(resolved);
      },
    },
    "/api/policies": {
      GET: async (request) => {
        const query = new URL(request.url).searchParams;
        const workspaceId = query.get("workspaceId");
        if (!workspaceId) {
          return error(400, "workspaceId is required");
        }
        return json(await service.listAccessPolicies(workspaceId));
      },
      POST: async (request) => {
        const body = await parseBody<{
          id?: string;
          workspaceId?: string;
          actorId?: string;
          clientId?: string;
          toolPathPattern?: string;
          decision?: PolicyDecision;
          priority?: number;
        }>(request);

        if (!body || !body.workspaceId || !body.toolPathPattern || !body.decision) {
          return error(400, "workspaceId, toolPathPattern, and decision are required");
        }

        if (body.decision !== "allow" && body.decision !== "require_approval" && body.decision !== "deny") {
          return error(400, "Invalid decision");
        }

        return json(await service.upsertAccessPolicy({
          id: body.id,
          workspaceId: body.workspaceId,
          actorId: body.actorId,
          clientId: body.clientId,
          toolPathPattern: body.toolPathPattern,
          decision: body.decision,
          priority: body.priority,
        }), body.id ? 200 : 201);
      },
    },
    "/api/credentials": {
      GET: async (request) => {
        const query = new URL(request.url).searchParams;
        const workspaceId = query.get("workspaceId");
        if (!workspaceId) {
          return error(400, "workspaceId is required");
        }
        return json(await service.listCredentials(workspaceId));
      },
      POST: async (request) => {
        const body = await parseBody<{
          id?: string;
          workspaceId?: string;
          sourceKey?: string;
          scope?: CredentialScope;
          actorId?: string;
          secretJson?: Record<string, unknown>;
        }>(request);

        if (!body || !body.workspaceId || !body.sourceKey || !body.scope || !body.secretJson) {
          return error(400, "workspaceId, sourceKey, scope, and secretJson are required");
        }

        if (body.scope !== "workspace" && body.scope !== "actor") {
          return error(400, "scope must be 'workspace' or 'actor'");
        }

        if (body.scope === "actor" && (!body.actorId || body.actorId.trim().length === 0)) {
          return error(400, "actorId is required for actor-scoped credential");
        }

        const credential = await service.upsertCredential({
          id: body.id,
          workspaceId: body.workspaceId,
          sourceKey: body.sourceKey,
          scope: body.scope,
          actorId: body.actorId,
          secretJson: body.secretJson,
        });

        return json({
          id: credential.id,
          workspaceId: credential.workspaceId,
          sourceKey: credential.sourceKey,
          scope: credential.scope,
          actorId: credential.actorId,
          hasSecret: true,
        }, body.id ? 200 : 201);
      },
    },
    "/internal/runs/:runId/tool-call": {
      POST: async (request) => {
        if (!isInternalAuthorized(request)) {
          return error(401, "Unauthorized internal call");
        }

        const body = await parseBody<{
          callId?: string;
          toolPath?: string;
          input?: unknown;
        }>(request);

        if (!body || !body.callId || !body.toolPath) {
          return error(400, "callId and toolPath are required");
        }

        const call: ToolCallRequest = {
          runId: request.params.runId,
          callId: body.callId,
          toolPath: body.toolPath,
          input: body.input,
        };

        return json(await service.handleExternalToolCall(call));
      },
    },
    "/internal/runs/:runId/output": {
      POST: async (request) => {
        if (!isInternalAuthorized(request)) {
          return error(401, "Unauthorized internal call");
        }

        const body = await parseBody<{
          stream?: "stdout" | "stderr";
          line?: string;
          timestamp?: number;
        }>(request);

        if (!body || (body.stream !== "stdout" && body.stream !== "stderr") || typeof body.line !== "string") {
          return error(400, "stream and line are required");
        }

        const event: RuntimeOutputEvent = {
          runId: request.params.runId,
          stream: body.stream,
          line: body.line,
          timestamp: typeof body.timestamp === "number" ? body.timestamp : Date.now(),
        };

        const task = await service.getTask(event.runId);
        if (!task) {
          return error(404, `Run not found: ${event.runId}`);
        }

        await service.appendRuntimeOutput(event);
        return json({ ok: true });
      },
    },
  },
  fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: jsonHeaders });
    }
    return new Response("Not found", { status: 404 });
  },
  error(cause) {
    console.error("executor server error", cause);
    return error(500, "Internal server error");
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`executor server listening on http://localhost:${server.port}`);
console.log(`[executor] internal callback base: ${internalBaseUrl} (${internalBaseSource})`);
console.log(`[executor] internal callback auth token enabled: yes`);
console.log(`[executor] tools loaded: ${tools.length} (${externalTools.length} external)`);
console.log(`[executor] server auto execute enabled: ${Bun.env.EXECUTOR_SERVER_AUTO_EXECUTE === "1" ? "yes" : "no"}`);
