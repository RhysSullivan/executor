import { registerRoutes as registerStripeRoutes } from "@convex-dev/stripe";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { httpRouter } from "convex/server";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authKit } from "./auth";
import { handleMcpRequest, type McpWorkspaceContext } from "../lib/mcp_server";
import type { AnonymousContext, PendingApprovalRecord, TaskRecord, ToolDescriptor } from "../lib/types";
import type { Id } from "./_generated/dataModel";

const http = httpRouter();
const internalToken = process.env.EXECUTOR_INTERNAL_TOKEN ?? null;
const mcpJwksByServer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getMcpAuthorizationServer(): string | null {
  return process.env.MCP_AUTHORIZATION_SERVER
    ?? process.env.MCP_AUTHORIZATION_SERVER_URL
    ?? process.env.WORKOS_AUTHKIT_ISSUER
    ?? process.env.WORKOS_AUTHKIT_DOMAIN
    ?? null;
}

function getMcpAuthConfig(): {
  enabled: boolean;
  authorizationServer: string | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
} {
  const authorizationServer = getMcpAuthorizationServer();
  if (!authorizationServer) {
    return {
      enabled: false,
      authorizationServer: null,
      jwks: null,
    };
  }

  const existingJwks = mcpJwksByServer.get(authorizationServer);
  if (existingJwks) {
    return {
      enabled: true,
      authorizationServer,
      jwks: existingJwks,
    };
  }

  const jwks = createRemoteJWKSet(new URL("/oauth2/jwks", authorizationServer));
  mcpJwksByServer.set(authorizationServer, jwks);
  return {
    enabled: true,
    authorizationServer,
    jwks,
  };
}

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

async function verifyMcpToken(
  request: Request,
  config: ReturnType<typeof getMcpAuthConfig>,
): Promise<{ subject: string } | null> {
  if (!config.enabled || !config.authorizationServer || !config.jwks) {
    return null;
  }

  const token = parseBearerToken(request);
  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, config.jwks, {
      issuer: config.authorizationServer,
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }

    return { subject: payload.sub };
  } catch {
    return null;
  }
}

function parseMcpContext(url: URL): {
  workspaceId: string;
  clientId?: string;
  sessionId?: string;
} | undefined {
  const workspaceId = url.searchParams.get("workspaceId");
  if (!workspaceId) return undefined;
  const clientId = url.searchParams.get("clientId") ?? undefined;
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  return { workspaceId, clientId, sessionId };
}

function isInternalAuthorized(request: Request): boolean {
  if (!internalToken) return false;
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
  const mcpAuthConfig = getMcpAuthConfig();
  const auth = await verifyMcpToken(request, mcpAuthConfig);
  const requestedContext = parseMcpContext(url);

  if (mcpAuthConfig.enabled && !requestedContext) {
    return Response.json(
      { error: "workspaceId query parameter is required when MCP OAuth is enabled" },
      { status: 400 },
    );
  }

  let context: McpWorkspaceContext | undefined;
  if (requestedContext) {
    try {
      if (mcpAuthConfig.enabled && auth?.subject) {
        const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForWorkosSubject, {
          workspaceId: requestedContext.workspaceId as Id<"workspaces">,
          subject: auth.subject,
        });

        context = {
          workspaceId: requestedContext.workspaceId,
          actorId: access.actorId,
          clientId: requestedContext.clientId,
        };
      } else {
        if (mcpAuthConfig.enabled && !requestedContext.sessionId) {
          return unauthorizedMcpResponse(request, "No valid bearer token provided.");
        }

        const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
          workspaceId: requestedContext.workspaceId as Id<"workspaces">,
          sessionId: requestedContext.sessionId,
        });

        if (mcpAuthConfig.enabled && access.provider !== "anonymous") {
          return unauthorizedMcpResponse(
            request,
            "Bearer token required for non-anonymous sessions.",
          );
        }

        context = {
          workspaceId: requestedContext.workspaceId,
          actorId: access.actorId,
          clientId: requestedContext.clientId,
          sessionId: requestedContext.sessionId,
        };
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Workspace authorization failed" },
        { status: 403 },
      );
    }
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
      return (await ctx.runMutation(internal.executor.createTaskInternal, {
        ...input,
        workspaceId: input.workspaceId as Id<"workspaces">,
      })) as { task: TaskRecord };
    },
    getTask: async (taskId: string, workspaceId?: string) => {
      if (workspaceId) {
        return (await ctx.runQuery(internal.database.getTaskInWorkspace, { taskId, workspaceId: workspaceId as Id<"workspaces"> })) as TaskRecord | null;
      }
      return null;
    },
    subscribe: () => {
      return () => {};
    },
    bootstrapAnonymousContext: async (sessionId?: string) => {
      return (await ctx.runMutation(internal.database.bootstrapAnonymousSession, { sessionId })) as AnonymousContext;
    },
    listTools: async (toolContext?: { workspaceId: string; actorId?: string; clientId?: string }) => {
      if (!toolContext) {
        return [];
      }

      return (await ctx.runAction(internal.executorNode.listToolsInternal, { ...toolContext, workspaceId: toolContext.workspaceId as Id<"workspaces"> })) as ToolDescriptor[];
    },
    listToolsForTypecheck: async (toolContext: { workspaceId: string; actorId?: string; clientId?: string }) => {
      const result = await ctx.runAction(internal.executorNode.listToolsWithWarningsInternal, { ...toolContext, workspaceId: toolContext.workspaceId as Id<"workspaces"> }) as {
        tools: ToolDescriptor[];
        dtsUrls?: Record<string, string>;
      };

      return {
        tools: result.tools,
        dtsUrls: result.dtsUrls ?? {},
      };
    },
    listPendingApprovals: async (workspaceId: string) => {
      return (await ctx.runQuery(internal.database.listPendingApprovals, { workspaceId: workspaceId as Id<"workspaces"> })) as PendingApprovalRecord[];
    },
    resolveApproval: async (input: {
      workspaceId: string;
      approvalId: string;
      decision: "approved" | "denied";
      reviewerId?: string;
      reason?: string;
    }) => {
      return await ctx.runMutation(internal.executor.resolveApprovalInternal, {
        ...input,
        workspaceId: input.workspaceId as Id<"workspaces">,
      });
    },
  };

  return await handleMcpRequest(service, request, context);
});

const oauthProtectedResourceHandler = httpAction(async (_ctx, request) => {
  const mcpAuthConfig = getMcpAuthConfig();
  if (!mcpAuthConfig.enabled || !mcpAuthConfig.authorizationServer) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  const url = new URL(request.url);
  return Response.json({
    resource: `${url.origin}/mcp`,
    authorization_servers: [mcpAuthConfig.authorizationServer],
    bearer_methods_supported: ["header"],
  });
});

const oauthAuthorizationServerProxyHandler = httpAction(async (_ctx, request) => {
  const mcpAuthConfig = getMcpAuthConfig();
  if (!mcpAuthConfig.enabled || !mcpAuthConfig.authorizationServer) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  const upstream = new URL("/.well-known/oauth-authorization-server", mcpAuthConfig.authorizationServer);
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

  const task = await ctx.runQuery(internal.database.getTask, { taskId: parsed.runId });
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
