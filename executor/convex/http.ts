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

  const jwks = createRemoteJWKSet(new URL("/oauth2/jwks", authorizationServer));
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

/**
 * Validated boundary for external workspace ID strings.
 * Convex IDs are opaque strings at runtime; this cast is the single
 * validated entry point so downstream code never needs ad-hoc casts.
 */
function parseWorkspaceId(raw: string): Id<"workspaces"> {
  return raw as Id<"workspaces">;
}

function parseMcpContext(url: URL): {
  workspaceId: Id<"workspaces">;
  clientId?: string;
  sessionId?: string;
} | undefined {
  const raw = url.searchParams.get("workspaceId");
  if (!raw) return undefined;
  const workspaceId = parseWorkspaceId(raw);
  const clientId = url.searchParams.get("clientId") ?? undefined;
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  return { workspaceId, clientId, sessionId };
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
          workspaceId: requestedContext.workspaceId,
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
          workspaceId: requestedContext.workspaceId,
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
      workspaceId: Id<"workspaces">;
      actorId: string;
      clientId?: string;
    }) => {
      return (await ctx.runMutation(internal.executor.createTaskInternal, {
        ...input,
      })) as { task: TaskRecord };
    },
    getTask: async (taskId: string, workspaceId?: Id<"workspaces">) => {
      if (workspaceId) {
        return (await ctx.runQuery(internal.database.getTaskInWorkspace, { taskId, workspaceId })) as TaskRecord | null;
      }
      return null;
    },
    subscribe: () => {
      return () => {};
    },
    bootstrapAnonymousContext: async (sessionId?: string) => {
      return (await ctx.runMutation(internal.database.bootstrapAnonymousSession, { sessionId })) as AnonymousContext;
    },
    listTools: async (toolContext?: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string }) => {
      if (!toolContext) {
        return [];
      }

      return (await ctx.runAction(internal.executorNode.listToolsInternal, { ...toolContext })) as ToolDescriptor[];
    },
    listToolsForTypecheck: async (toolContext: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string }) => {
      const result = await ctx.runAction(internal.executorNode.listToolsWithWarningsInternal, { ...toolContext }) as {
        tools: ToolDescriptor[];
        dtsUrls?: Record<string, string>;
      };

      return {
        tools: result.tools,
        dtsUrls: result.dtsUrls ?? {},
      };
    },
    typecheckRunCode: async (input: {
      code: string;
      workspaceId: Id<"workspaces">;
      actorId?: string;
      clientId?: string;
    }) => {
      const result = await ctx.runAction(internal.mcpNode.typecheckRunCodeInternal, {
        code: input.code,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        clientId: input.clientId,
      });
      return result;
    },
    listPendingApprovals: async (workspaceId: Id<"workspaces">) => {
      return (await ctx.runQuery(internal.database.listPendingApprovals, { workspaceId })) as PendingApprovalRecord[];
    },
    resolveApproval: async (input: {
      workspaceId: Id<"workspaces">;
      approvalId: string;
      decision: "approved" | "denied";
      reviewerId?: string;
      reason?: string;
    }) => {
      return await ctx.runMutation(internal.executor.resolveApprovalInternal, {
        ...input,
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

authKit.registerRoutes(http);
registerStripeRoutes(http, components.stripe, {
  webhookPath: "/stripe/webhook",
});

http.route({ path: "/mcp", method: "POST", handler: mcpHandler });
http.route({ path: "/mcp", method: "GET", handler: mcpHandler });
http.route({ path: "/mcp", method: "DELETE", handler: mcpHandler });
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: oauthProtectedResourceHandler });
http.route({ path: "/.well-known/oauth-authorization-server", method: "GET", handler: oauthAuthorizationServerProxyHandler });

export default http;
