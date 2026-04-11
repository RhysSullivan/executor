// ---------------------------------------------------------------------------
// Cloud MCP handler — OAuth + routing to session Durable Objects
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHKIT_DOMAIN = "https://signin.executor.sh";
const RESOURCE_ORIGIN = "https://executor.sh";
const JWKS_URL = new URL(`${AUTHKIT_DOMAIN}/oauth2/jwks`);

const jwks = createRemoteJWKSet(JWKS_URL);

// ---------------------------------------------------------------------------
// OAuth metadata endpoints
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });

const protectedResourceMetadata = () =>
  jsonResponse({
    resource: RESOURCE_ORIGIN,
    authorization_servers: [AUTHKIT_DOMAIN],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
  });

const authorizationServerMetadata = async () => {
  try {
    const res = await fetch(`${AUTHKIT_DOMAIN}/.well-known/oauth-authorization-server`);
    if (!res.ok) return jsonResponse({ error: "upstream_error" }, 502);
    return jsonResponse(await res.json());
  } catch {
    return jsonResponse({ error: "upstream_error" }, 502);
  }
};

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

type VerifiedToken = {
  /** The WorkOS account ID (user ID). */
  accountId: string;
  /** The WorkOS organization ID, if the session has org context. */
  organizationId: string | null;
};

const BEARER_PREFIX = "Bearer ";

const verifyBearerToken = async (request: Request): Promise<VerifiedToken | null> => {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith(BEARER_PREFIX)) return null;

  const token = authHeader.slice(BEARER_PREFIX.length);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: AUTHKIT_DOMAIN,
    });
    if (!payload.sub) return null;
    return {
      accountId: payload.sub,
      organizationId: (payload.org_id as string | undefined) ?? null,
    };
  } catch {
    return null;
  }
};

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${RESOURCE_ORIGIN}/.well-known/oauth-protected-resource"`,
      "access-control-allow-origin": "*",
    },
  });

// ---------------------------------------------------------------------------
// DO routing
// ---------------------------------------------------------------------------

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Route an MCP request to a session DO.
 *
 * - No session header → create a new DO (initialize flow)
 * - With session header → route to existing DO
 */
const handleMcpRequest_POST = async (request: Request, token: VerifiedToken): Promise<Response> => {
  if (!token.organizationId) {
    return jsonRpcError(403, -32001, "No organization in session — log in via the web app first");
  }

  try {
    const ns = env.MCP_SESSION;
    const sessionId = request.headers.get("mcp-session-id");

    if (sessionId) {
      const id = ns.idFromString(sessionId);
      const stub = ns.get(id);
      return await stub.handleRequest(request);
    }

    // New session — create a DO and initialize it
    const id = ns.newUniqueId();
    const stub = ns.get(id);

    await stub.init({ organizationId: token.organizationId });

    return await stub.handleRequest(request);
  } catch (err) {
    console.error("[mcp] POST handler error:", err instanceof Error ? err.stack : err);
    return jsonRpcError(500, -32603, "Internal server error");
  }
};

const handleMcpRequest_DELETE = async (request: Request): Promise<Response> => {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) return new Response(null, { status: 204 });

  // Let the DO handle the DELETE — its transport will clean up
  const ns = env.MCP_SESSION;
  const id = ns.idFromString(sessionId);
  const stub = ns.get(id);
  return stub.handleRequest(request);
};

const handleMcpRequest_GET = async (request: Request): Promise<Response> => {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) {
    return jsonRpcError(400, -32000, "mcp-session-id header required for SSE");
  }

  const ns = env.MCP_SESSION;
  const id = ns.idFromString(sessionId);
  const stub = ns.get(id);
  return stub.handleRequest(request);
};

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

export const handleMcpRequest = async (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // CORS preflight for MCP paths
  if (
    request.method === "OPTIONS" &&
    (pathname === "/mcp" || pathname.startsWith("/.well-known/"))
  ) {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers":
          "authorization, content-type, mcp-session-id, accept, mcp-protocol-version",
        "access-control-expose-headers": "mcp-session-id",
      },
    });
  }

  // Well-known endpoints (public, no auth)
  if (pathname === "/.well-known/oauth-protected-resource") {
    return protectedResourceMetadata();
  }
  if (pathname === "/.well-known/oauth-authorization-server") {
    return authorizationServerMetadata();
  }

  // MCP endpoint
  if (pathname !== "/mcp") return null;

  // Auth required for all MCP methods
  const token = await verifyBearerToken(request);
  if (!token) return unauthorized();

  switch (request.method) {
    case "POST":
      return handleMcpRequest_POST(request, token);
    case "GET":
      return handleMcpRequest_GET(request);
    case "DELETE":
      return handleMcpRequest_DELETE(request);
    default:
      return jsonRpcError(405, -32001, "Method not allowed");
  }
};
