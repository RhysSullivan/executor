import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Id } from "../_generated/dataModel.d.ts";
import type { ActionCtx } from "../_generated/server";

export const MCP_PATH = "/mcp";
export const MCP_ANONYMOUS_PATH = "/mcp/anonymous";

type McpAuthConfig = {
  enabled: boolean;
  authorizationServer: string | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
};

type VerifiedMcpToken = { provider: "workos"; subject: string };

type ParsedMcpContext = {
  workspaceId?: Id<"workspaces">;
  accountId?: string;
  sessionId?: string;
};

function parseWorkspaceId(raw: string): Id<"workspaces"> {
  return raw as Id<"workspaces">;
}

function getMcpAuthorizationServer(): string | null {
  return process.env.MCP_AUTHORIZATION_SERVER
    ?? process.env.MCP_AUTHORIZATION_SERVER_URL
    ?? process.env.WORKOS_AUTHKIT_ISSUER
    ?? process.env.WORKOS_AUTHKIT_DOMAIN
    ?? null;
}

export function getMcpAuthConfig(): McpAuthConfig {
  const authorizationServer = getMcpAuthorizationServer();
  if (!authorizationServer) {
    return {
      enabled: false,
      authorizationServer: null,
      jwks: null,
    };
  }

  const jwks = authorizationServer
    ? createRemoteJWKSet(new URL("/oauth2/jwks", authorizationServer))
    : null;

  return {
    enabled: true,
    authorizationServer,
    jwks,
  };
}

export function isAnonymousSessionId(sessionId?: string): boolean {
  if (!sessionId) return false;
  return sessionId.startsWith("anon_session_") || sessionId.startsWith("mcp_");
}

export function selectMcpAuthProvider(
  config: McpAuthConfig,
): "workos" | null {
  if (!config.enabled) {
    return null;
  }

  if (config.authorizationServer) {
    return "workos";
  }

  return null;
}

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function resourceMetadataUrl(request: Request): string {
  const url = new URL(request.url);
  const metadata = new URL("/.well-known/oauth-protected-resource", url.origin);
  metadata.search = url.search;
  const resource = new URL(url.pathname, url.origin);
  resource.search = url.search;
  metadata.searchParams.set("resource", resource.toString());
  return metadata.toString();
}

export function unauthorizedMcpResponse(request: Request, message: string): Response {
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

export async function verifyMcpToken(
  _ctx: ActionCtx,
  request: Request,
  config: McpAuthConfig,
): Promise<VerifiedMcpToken | null> {
  if (!config.enabled) {
    return null;
  }

  const token = parseBearerToken(request);
  if (!token) {
    return null;
  }

  if (config.authorizationServer && config.jwks) {
    try {
      const { payload } = await jwtVerify(token, config.jwks, {
        issuer: config.authorizationServer,
      });

      if (typeof payload.sub === "string" && payload.sub.length > 0) {
        const providerClaim = typeof payload.provider === "string" ? payload.provider : undefined;
        if (providerClaim !== "anonymous") {
          return {
            provider: "workos",
            subject: payload.sub,
          };
        }
      }
    } catch {
      // Token did not verify against configured auth server.
    }
  }

  return null;
}

export function parseMcpContext(url: URL): ParsedMcpContext | undefined {
  const raw = url.searchParams.get("workspaceId");
  const workspaceId = raw ? parseWorkspaceId(raw) : undefined;
  const accountId = url.searchParams.get("accountId") ?? undefined;
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  if (!workspaceId && !accountId && !sessionId) {
    return undefined;
  }
  return { workspaceId, accountId, sessionId };
}
