import { ConvexHttpClient } from "convex/browser";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { api } from "./convex/_generated/api";
import { handleMcpRequest, type McpWorkspaceContext } from "./lib/mcp_server";
import type { AnonymousContext, PendingApprovalRecord, TaskRecord, ToolDescriptor } from "./lib/types";
import type { Id } from "./convex/_generated/dataModel";

const convexUrlFromEnv = Bun.env.CONVEX_URL;
if (!convexUrlFromEnv) {
  throw new Error("CONVEX_URL is required.");
}
const convexUrl: string = convexUrlFromEnv;

const mcpAuthorizationServer =
  Bun.env.MCP_AUTHORIZATION_SERVER
  ?? Bun.env.MCP_AUTHORIZATION_SERVER_URL
  ?? Bun.env.WORKOS_AUTHKIT_ISSUER
  ?? Bun.env.WORKOS_AUTHKIT_DOMAIN;
const mcpGatewayRequireAuth = Bun.env.MCP_GATEWAY_REQUIRE_AUTH === "1";
const mcpAuthEnabled = mcpGatewayRequireAuth && Boolean(mcpAuthorizationServer);
const mcpJwks = mcpAuthorizationServer
  ? createRemoteJWKSet(new URL("/oauth2/jwks", mcpAuthorizationServer))
  : null;

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
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

async function verifyMcpToken(request: Request): Promise<boolean> {
  if (!mcpAuthEnabled || !mcpAuthorizationServer || !mcpJwks) {
    return true;
  }

  const token = parseBearerToken(request);
  if (!token) {
    return false;
  }

  try {
    const { payload } = await jwtVerify(token, mcpJwks, {
      issuer: mcpAuthorizationServer,
    });
    return typeof payload.sub === "string" && payload.sub.length > 0;
  } catch {
    return false;
  }
}

async function verifyOptionalMcpToken(request: Request): Promise<string | null> {
  if (!mcpAuthorizationServer || !mcpJwks) {
    return null;
  }

  const token = parseBearerToken(request);
  if (!token) {
    return null;
  }

  const { payload } = await jwtVerify(token, mcpJwks, {
    issuer: mcpAuthorizationServer,
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return null;
  }

  return payload.sub;
}

function parseRequestedContext(url: URL): {
  workspaceId?: string;
  actorId?: string;
  clientId?: string;
  sessionId?: string;
} {
  const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
  const actorId = url.searchParams.get("actorId") ?? undefined;
  const clientId = url.searchParams.get("clientId") ?? undefined;
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  return { workspaceId, actorId, clientId, sessionId };
}

function createService(context?: McpWorkspaceContext, bearerToken?: string) {
  const convex = new ConvexHttpClient(convexUrl);
  if (bearerToken) {
    convex.setAuth(bearerToken);
  }

  const workspaceId = context?.workspaceId;
  const sessionId = context?.sessionId;

  return {
    createTask: async (input: {
      code: string;
      timeoutMs?: number;
      runtimeId?: string;
      metadata?: Record<string, unknown>;
      workspaceId: string;
      actorId: string;
      clientId?: string;
    }) => {
      const created = await convex.mutation(api.executor.createTask, {
        workspaceId: input.workspaceId as Id<"workspaces">,
        sessionId,
        code: input.code,
        timeoutMs: input.timeoutMs,
        runtimeId: input.runtimeId,
        metadata: input.metadata,
        actorId: input.actorId,
        clientId: input.clientId,
      });
      return created as { task: TaskRecord };
    },

    getTask: async (taskId: string, workspace?: string) => {
      const effectiveWorkspaceId = workspace ?? workspaceId;
      if (!effectiveWorkspaceId) {
        return null;
      }
      const task = await convex.query(api.workspace.getTaskInWorkspace, {
        workspaceId: effectiveWorkspaceId as Id<"workspaces">,
        sessionId,
        taskId,
      });
      return task as TaskRecord | null;
    },

    subscribe: () => () => {},

    bootstrapAnonymousContext: async (requestedSessionId?: string) => {
      const bootstrap = await convex.mutation(api.workspace.bootstrapAnonymousSession, {
        sessionId: requestedSessionId,
      });
      return bootstrap as AnonymousContext;
    },

    listTools: async (toolContext?: { workspaceId: string; actorId?: string; clientId?: string }) => {
      if (!toolContext) {
        return [];
      }
      const tools = await convex.action(api.executorNode.listTools, {
        workspaceId: toolContext.workspaceId as Id<"workspaces">,
        sessionId,
        actorId: toolContext.actorId,
        clientId: toolContext.clientId,
      });
      return tools as ToolDescriptor[];
    },

    listPendingApprovals: async (approvalWorkspaceId: string) => {
      const approvals = await convex.query(api.workspace.listPendingApprovals, {
        workspaceId: approvalWorkspaceId as Id<"workspaces">,
        sessionId,
      });
      return approvals as PendingApprovalRecord[];
    },

    resolveApproval: async (input: {
      workspaceId: string;
      approvalId: string;
      decision: "approved" | "denied";
      reviewerId?: string;
      reason?: string;
    }) => {
      return await convex.mutation(api.executor.resolveApproval, {
        workspaceId: input.workspaceId as Id<"workspaces">,
        sessionId,
        approvalId: input.approvalId,
        decision: input.decision,
        reviewerId: input.reviewerId,
        reason: input.reason,
      });
    },
  };
}

async function resolveContext(
  requested: {
    workspaceId?: string;
    actorId?: string;
    clientId?: string;
    sessionId?: string;
  },
  bearerToken?: string,
): Promise<McpWorkspaceContext | undefined> {
  if (!requested.workspaceId) {
    return undefined;
  }

  if (requested.actorId) {
    return {
      workspaceId: requested.workspaceId,
      actorId: requested.actorId,
      clientId: requested.clientId,
      sessionId: requested.sessionId,
    };
  }

  if (!bearerToken && !requested.sessionId) {
    throw new Error("Provide actorId+sessionId or authenticate with MCP OAuth.");
  }

  const convex = new ConvexHttpClient(convexUrl);
  if (bearerToken) {
    convex.setAuth(bearerToken);
  }

  const requestContext = await convex.query(api.workspace.getRequestContext, {
    workspaceId: requested.workspaceId as Id<"workspaces">,
    sessionId: requested.sessionId,
  });

  return {
    workspaceId: requestContext.workspaceId,
    actorId: requestContext.actorId,
    clientId: requested.clientId,
    sessionId: requested.sessionId,
  };
}

async function handleMcp(request: Request): Promise<Response> {
  let verifiedSubject: string | null = null;

  if (mcpGatewayRequireAuth) {
    const authed = await verifyMcpToken(request);
    if (!authed) {
      return unauthorizedMcpResponse(request, "No valid bearer token provided.");
    }
  } else {
    try {
      verifiedSubject = await verifyOptionalMcpToken(request);
    } catch {
      verifiedSubject = null;
    }
  }

  const url = new URL(request.url);
  const requested = parseRequestedContext(url);
  if (mcpGatewayRequireAuth && !requested.workspaceId) {
    return Response.json(
      { error: "workspaceId query parameter is required when MCP OAuth is enabled" },
      { status: 400 },
    );
  }

  const bearerToken = parseBearerToken(request) ?? undefined;
  const effectiveBearerToken = verifiedSubject && bearerToken ? bearerToken : undefined;
  let context: McpWorkspaceContext | undefined;
  if (requested.workspaceId) {
    try {
      context = await resolveContext(requested, effectiveBearerToken);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Workspace authorization failed" },
        { status: 403 },
      );
    }
  }

  const service = createService(context, effectiveBearerToken);
  return await handleMcpRequest(service, request, context);
}

async function handleAuthServerMetadataProxy(): Promise<Response> {
  if (!mcpAuthEnabled || !mcpAuthorizationServer) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }
  const authServer = mcpAuthorizationServer;

  const upstream = await fetch(new URL("/.well-known/oauth-authorization-server", authServer));
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": upstream.headers.get("cache-control") ?? "public, max-age=60",
    },
  });
}

function handleProtectedResourceMetadata(request: Request): Response {
  if (!mcpAuthEnabled || !mcpAuthorizationServer) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  const url = new URL(request.url);
  return Response.json({
    resource: `${url.origin}/mcp`,
    authorization_servers: [mcpAuthorizationServer],
    bearer_methods_supported: ["header"],
  });
}

const port = Number(Bun.env.PORT ?? 3003);

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    if (url.pathname === "/" || url.pathname === "/mcp") {
      if (request.method === "POST" || request.method === "GET" || request.method === "DELETE") {
        return await handleMcp(request);
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return handleProtectedResourceMetadata(request);
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return await handleAuthServerMetadataProxy();
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `[executor-mcp-gateway] listening on http://localhost:${port}/mcp (auth ${mcpGatewayRequireAuth ? "required" : "optional"})`,
);
