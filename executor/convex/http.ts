import { registerRoutes as registerStripeRoutes } from "@convex-dev/stripe";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { httpRouter } from "convex/server";
import { api, components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authKit } from "./auth";
import { handleMcpRequest, type McpWorkspaceContext } from "./lib/mcp_server";
import type { AnonymousContext, PendingApprovalRecord, TaskRecord, ToolDescriptor } from "./lib/types";

const http = httpRouter();
const internalToken = process.env.EXECUTOR_INTERNAL_TOKEN ?? "executor_internal_local_dev_token";
const mcpAuthorizationServer =
  process.env.MCP_AUTHORIZATION_SERVER
  ?? process.env.MCP_AUTHORIZATION_SERVER_URL
  ?? process.env.WORKOS_AUTHKIT_ISSUER
  ?? process.env.WORKOS_AUTHKIT_DOMAIN;
const mcpAuthEnabled = Boolean(mcpAuthorizationServer);
const mcpJwks = mcpAuthorizationServer
  ? createRemoteJWKSet(new URL("/oauth2/jwks", mcpAuthorizationServer))
  : null;

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function resourceMetadataUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/.well-known/oauth-protected-resource`;
}

function unauthorizedMcpResponse(request: Request, message: string): Response {
  const challenge = [
    'Bearer error="unauthorized"',
    'error_description="Authorization needed"',
    `resource_metadata="${resourceMetadataUrl(request)}"`,
  ].join(", ");

  return Response.json(
    { error: message },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": challenge,
      },
    },
  );
}

async function verifyMcpToken(request: Request): Promise<{ subject: string } | null> {
  if (!mcpAuthEnabled || !mcpAuthorizationServer || !mcpJwks) {
    return { subject: "" };
  }

  const token = parseBearerToken(request);
  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, mcpJwks, {
      issuer: mcpAuthorizationServer,
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }

    return { subject: payload.sub };
  } catch {
    return null;
  }
}

function parseMcpContext(url: URL, tokenSubject?: string): McpWorkspaceContext | undefined {
  const workspaceId = url.searchParams.get("workspaceId");
  const actorId = tokenSubject ?? url.searchParams.get("actorId");
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
  const auth = await verifyMcpToken(request);
  if (!auth) {
    return unauthorizedMcpResponse(request, "No valid bearer token provided.");
  }

  const tokenSubject = mcpAuthEnabled ? auth.subject : undefined;
  const context = parseMcpContext(url, tokenSubject);

  if (mcpAuthEnabled && !context) {
    return Response.json(
      { error: "workspaceId query parameter is required when MCP OAuth is enabled" },
      { status: 400 },
    );
  }

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
    listPendingApprovals: async (workspaceId: string) => {
      return (await ctx.runQuery(api.database.listPendingApprovals, { workspaceId })) as PendingApprovalRecord[];
    },
    resolveApproval: async (input: {
      workspaceId: string;
      approvalId: string;
      decision: "approved" | "denied";
      reviewerId?: string;
      reason?: string;
    }) => {
      return await ctx.runMutation(api.executor.resolveApproval, input);
    },
  };

  return await handleMcpRequest(service, request, context);
});

const oauthProtectedResourceHandler = httpAction(async (_ctx, request) => {
  if (!mcpAuthEnabled || !mcpAuthorizationServer) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  const url = new URL(request.url);
  return Response.json({
    resource: `${url.origin}/mcp`,
    authorization_servers: [mcpAuthorizationServer],
    bearer_methods_supported: ["header"],
  });
});

const oauthAuthorizationServerProxyHandler = httpAction(async (_ctx, request) => {
  if (!mcpAuthEnabled || !mcpAuthorizationServer) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  const upstream = new URL("/.well-known/oauth-authorization-server", mcpAuthorizationServer);
  const response = await fetch(upstream.toString(), {
    headers: { accept: "application/json" },
  });

  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
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
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: oauthProtectedResourceHandler });
http.route({ path: "/.well-known/oauth-authorization-server", method: "GET", handler: oauthAuthorizationServerProxyHandler });

http.route({
  pathPrefix: "/internal/runs/",
  method: "POST",
  handler: internalRunsHandler,
});

export default http;
