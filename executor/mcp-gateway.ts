import { ConvexHttpClient } from "convex/browser";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { api } from "./convex/_generated/api";
import { handleMcpRequest, type McpWorkspaceContext } from "./lib/mcp_server";
import { AnonymousOAuthServer, OAuthBadRequest } from "./lib/anonymous-oauth";
import { ConvexOAuthStorage } from "./lib/convex-oauth-storage";
import type { AnonymousContext, PendingApprovalRecord, TaskRecord, ToolDescriptor } from "./lib/types";
import type { Id } from "./convex/_generated/dataModel";

// ---------------------------------------------------------------------------
// Verified token result — unified across WorkOS and self-issued anonymous JWTs
// ---------------------------------------------------------------------------

interface VerifiedToken {
  sub: string;
  provider: "workos" | "anonymous";
  /** The raw bearer token string (needed for WorkOS tokens to forward to Convex). */
  rawToken: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let convexUrl: string | undefined;
let workosAuthorizationServer: string | undefined;
let workosJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let anonOAuth: AnonymousOAuthServer | null = null;

function loadConfigFromEnv(): void {
  const convexUrlFromEnv = Bun.env.CONVEX_URL;
  if (!convexUrlFromEnv) {
    throw new Error("CONVEX_URL is required.");
  }

  convexUrl = convexUrlFromEnv;
  workosAuthorizationServer =
    Bun.env.MCP_AUTHORIZATION_SERVER
    ?? Bun.env.MCP_AUTHORIZATION_SERVER_URL
    ?? Bun.env.WORKOS_AUTHKIT_ISSUER
    ?? Bun.env.WORKOS_AUTHKIT_DOMAIN;
  workosJwks = workosAuthorizationServer
    ? createRemoteJWKSet(new URL("/oauth2/jwks", workosAuthorizationServer))
    : null;
}

async function initAnonymousOAuth(issuer: string): Promise<void> {
  const internalSecret = Bun.env.EXECUTOR_INTERNAL_TOKEN;
  const storage = convexUrl && internalSecret
    ? new ConvexOAuthStorage(convexUrl, internalSecret)
    : undefined;

  anonOAuth = new AnonymousOAuthServer({ issuer, storage });
  await anonOAuth.init();
}

function requireConvexUrl(): string {
  if (!convexUrl) {
    throw new Error("CONVEX_URL is required.");
  }
  return convexUrl;
}

// ---------------------------------------------------------------------------
// Token parsing & verification
// ---------------------------------------------------------------------------

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Unified token verification.  Tries the self-issued anonymous OAuth server
 * first (fast, in-process), then falls back to the external WorkOS JWKS.
 */
async function verifyToken(request: Request): Promise<VerifiedToken | null> {
  const rawToken = parseBearerToken(request);
  if (!rawToken) {
    return null;
  }

  // 1. Try the self-issued anonymous OAuth server
  if (anonOAuth) {
    const anon = await anonOAuth.verifyToken(rawToken);
    if (anon) {
      return { sub: anon.sub, provider: "anonymous", rawToken };
    }
  }

  // 2. Try WorkOS
  if (workosAuthorizationServer && workosJwks) {
    try {
      const { payload } = await jwtVerify(rawToken, workosJwks, {
        issuer: workosAuthorizationServer,
      });
      if (typeof payload.sub === "string" && payload.sub.length > 0) {
        return { sub: payload.sub, provider: "workos", rawToken };
      }
    } catch {
      // Not a valid WorkOS token either
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// OAuth response helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Workspace ID parsing
// ---------------------------------------------------------------------------

/**
 * Validated boundary for external workspace ID strings.
 * Convex IDs are opaque strings at runtime; this cast is the single
 * validated entry point so downstream code never needs ad-hoc casts.
 */
function parseWorkspaceId(raw: string): Id<"workspaces"> {
  return raw as Id<"workspaces">;
}

function parseRequestedContext(url: URL): {
  workspaceId?: Id<"workspaces">;
  clientId?: string;
} {
  const rawWorkspaceId = url.searchParams.get("workspaceId");
  const workspaceId = rawWorkspaceId ? parseWorkspaceId(rawWorkspaceId) : undefined;
  const clientId = url.searchParams.get("clientId") ?? undefined;
  return { workspaceId, clientId };
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

function createService(context?: McpWorkspaceContext, bearerToken?: string) {
  const convex = new ConvexHttpClient(requireConvexUrl());
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
      workspaceId: Id<"workspaces">;
      actorId: string;
      clientId?: string;
    }) => {
      const created = await convex.mutation(api.executor.createTask, {
        workspaceId: input.workspaceId,
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

    getTask: async (taskId: string, workspace?: Id<"workspaces">) => {
      const effectiveWorkspaceId = workspace ?? workspaceId;
      if (!effectiveWorkspaceId) {
        return null;
      }
      const task = await convex.query(api.workspace.getTaskInWorkspace, {
        workspaceId: effectiveWorkspaceId,
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

    listTools: async (toolContext?: { workspaceId: Id<"workspaces">; actorId?: string; clientId?: string }) => {
      if (!toolContext) {
        return [];
      }
      const tools = await convex.action(api.executorNode.listTools, {
        workspaceId: toolContext.workspaceId,
        sessionId,
        actorId: toolContext.actorId,
        clientId: toolContext.clientId,
      });
      return tools as ToolDescriptor[];
    },

    listPendingApprovals: async (approvalWorkspaceId: Id<"workspaces">) => {
      const approvals = await convex.query(api.workspace.listPendingApprovals, {
        workspaceId: approvalWorkspaceId,
        sessionId,
      });
      return approvals as PendingApprovalRecord[];
    },

    resolveApproval: async (input: {
      workspaceId: Id<"workspaces">;
      approvalId: string;
      decision: "approved" | "denied";
      reviewerId?: string;
      reason?: string;
    }) => {
      return await convex.mutation(api.executor.resolveApproval, {
        workspaceId: input.workspaceId,
        sessionId,
        approvalId: input.approvalId,
        decision: input.decision,
        reviewerId: input.reviewerId,
        reason: input.reason,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Context resolution
// ---------------------------------------------------------------------------

async function resolveContextForWorkos(
  workspaceId: Id<"workspaces">,
  bearerToken: string,
  clientId?: string,
): Promise<McpWorkspaceContext> {
  const convex = new ConvexHttpClient(requireConvexUrl());
  convex.setAuth(bearerToken);

  const requestContext = await convex.query(api.workspace.getRequestContext, {
    workspaceId,
  });

  return {
    workspaceId: requestContext.workspaceId,
    actorId: requestContext.actorId,
    clientId,
  };
}

// ---------------------------------------------------------------------------
// MCP handler
// ---------------------------------------------------------------------------

async function handleMcp(request: Request): Promise<Response> {
  const verified = await verifyToken(request);

  // No token at all — return 401 so MCP clients discover the auth server
  if (!verified) {
    return unauthorizedMcpResponse(request, "Authorization required.");
  }

  const url = new URL(request.url);
  const requested = parseRequestedContext(url);

  let context: McpWorkspaceContext | undefined;

  if (verified.provider === "workos") {
    // WorkOS-authenticated user: must provide workspaceId
    if (!requested.workspaceId) {
      return Response.json(
        { error: "workspaceId query parameter is required for authenticated users" },
        { status: 400 },
      );
    }

    try {
      context = await resolveContextForWorkos(
        requested.workspaceId,
        verified.rawToken,
        requested.clientId,
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Workspace authorization failed" },
        { status: 403 },
      );
    }
  }
  // Anonymous tokens: context is resolved lazily via bootstrapAnonymousContext
  // in the MCP server's run_code handler (using the token sub as the actor).
  // If workspaceId is provided, it will be passed through but the anonymous
  // session bootstrap will create one if needed.

  const bearerToken = verified.provider === "workos" ? verified.rawToken : undefined;
  const service = createService(context, bearerToken);
  return await handleMcpRequest(service, request, context);
}

// ---------------------------------------------------------------------------
// OAuth endpoints — self-issued anonymous auth server
// ---------------------------------------------------------------------------

function handleProtectedResourceMetadata(request: Request): Response {
  const url = new URL(request.url);
  const authorizationServers: string[] = [];

  // Always advertise the self-issued anonymous auth server
  if (anonOAuth) {
    authorizationServers.push(anonOAuth.getIssuer());
  }

  // Also advertise WorkOS if configured
  if (workosAuthorizationServer) {
    authorizationServers.push(workosAuthorizationServer);
  }

  if (authorizationServers.length === 0) {
    return Response.json({ error: "No authorization servers configured" }, { status: 404 });
  }

  return Response.json({
    resource: `${url.origin}/mcp`,
    authorization_servers: authorizationServers,
    bearer_methods_supported: ["header"],
  });
}

function handleAuthServerMetadata(): Response {
  if (!anonOAuth) {
    return Response.json({ error: "Anonymous OAuth server not initialized" }, { status: 500 });
  }
  return Response.json(anonOAuth.getMetadata());
}

function handleJwks(): Response {
  if (!anonOAuth) {
    return Response.json({ error: "Anonymous OAuth server not initialized" }, { status: 500 });
  }
  return Response.json(anonOAuth.getJwks(), {
    headers: { "cache-control": "public, max-age=3600" },
  });
}

async function handleRegister(request: Request): Promise<Response> {
  if (!anonOAuth) {
    return Response.json({ error: "Anonymous OAuth server not initialized" }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const registration = await anonOAuth.registerClient(body as any);
    return Response.json(registration, { status: 201 });
  } catch (error) {
    if (error instanceof OAuthBadRequest) {
      return Response.json(
        { error: "invalid_client_metadata", error_description: error.message },
        { status: 400 },
      );
    }
    throw error;
  }
}

async function handleAuthorize(request: Request): Promise<Response> {
  if (!anonOAuth) {
    return Response.json({ error: "Anonymous OAuth server not initialized" }, { status: 500 });
  }

  const url = new URL(request.url);
  try {
    const { redirectTo } = await anonOAuth.authorize(url.searchParams);
    return Response.redirect(redirectTo, 302);
  } catch (error) {
    if (error instanceof OAuthBadRequest) {
      return Response.json(
        { error: "invalid_request", error_description: error.message },
        { status: 400 },
      );
    }
    throw error;
  }
}

async function handleToken(request: Request): Promise<Response> {
  if (!anonOAuth) {
    return Response.json({ error: "Anonymous OAuth server not initialized" }, { status: 500 });
  }

  let body: URLSearchParams;
  try {
    const text = await request.text();
    body = new URLSearchParams(text);
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const tokens = await anonOAuth.exchangeToken(body);
    return Response.json(tokens, {
      headers: {
        "cache-control": "no-store",
        "pragma": "no-cache",
      },
    });
  } catch (error) {
    if (error instanceof OAuthBadRequest) {
      return Response.json(
        { error: "invalid_grant", error_description: error.message },
        { status: 400 },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startMcpGateway(
  port = Number(Bun.env.EXECUTOR_MCP_GATEWAY_PORT ?? Bun.env.PORT ?? 5313),
): Promise<ReturnType<typeof Bun.serve>> {
  loadConfigFromEnv();

  // Initialize the self-issued anonymous OAuth server.
  // The issuer must match the gateway's public origin.
  const gatewayOrigin = Bun.env.MCP_GATEWAY_ORIGIN ?? `http://localhost:${port}`;
  await initAnonymousOAuth(gatewayOrigin);

  // Periodically purge expired authorization codes
  setInterval(() => {
    anonOAuth?.purgeExpiredCodes();
  }, 60_000);

  const server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return new Response("ok");
      }

      // ── MCP endpoint ──────────────────────────────────────────────────
      if (url.pathname === "/" || url.pathname === "/mcp") {
        if (request.method === "POST" || request.method === "GET" || request.method === "DELETE") {
          return await handleMcp(request);
        }
        return new Response("Method Not Allowed", { status: 405 });
      }

      // ── OAuth discovery (RFC 9728 + RFC 8414) ─────────────────────────
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return handleProtectedResourceMetadata(request);
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return handleAuthServerMetadata();
      }

      // ── Self-issued OAuth endpoints ───────────────────────────────────
      if (url.pathname === "/oauth2/jwks") {
        return handleJwks();
      }

      if (url.pathname === "/register" && request.method === "POST") {
        return await handleRegister(request);
      }

      if (url.pathname === "/authorize" && request.method === "GET") {
        return await handleAuthorize(request);
      }

      if (url.pathname === "/token" && request.method === "POST") {
        return await handleToken(request);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const hasWorkos = Boolean(workosAuthorizationServer);
  console.log(
    `[executor-mcp-gateway] listening on http://localhost:${port}/mcp`
    + ` (anonymous-oauth: enabled, workos: ${hasWorkos ? "enabled" : "disabled"})`,
  );

  return server;
}

if (import.meta.main) {
  await startMcpGateway();
}
