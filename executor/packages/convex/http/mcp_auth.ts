import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  AnonymousOAuthServer,
} from "../../core/src/anonymous-oauth";
import { ActionOAuthStorage } from "./action_oauth_storage";

export const ANON_WORKSPACE_CLAIM = "workspace_id";
export const ANON_SESSION_CLAIM = "session_id";

export type McpAuthConfig = {
  enabled: boolean;
  anonymousEnabled: boolean;
  authorizationServer: string | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
};

export type VerifiedMcpToken =
  | { provider: "workos"; subject: string }
  | { provider: "anonymous"; subject: string; workspaceId?: Id<"workspaces">; sessionId?: string };

export type ParsedMcpContext = {
  workspaceId?: Id<"workspaces">;
  clientId?: string;
  sessionId?: string;
};

export function parseWorkspaceId(raw: string): Id<"workspaces"> {
  return raw as Id<"workspaces">;
}

export function getMcpAuthorizationServer(): string | null {
  return process.env.MCP_AUTHORIZATION_SERVER
    ?? process.env.MCP_AUTHORIZATION_SERVER_URL
    ?? process.env.WORKOS_AUTHKIT_ISSUER
    ?? process.env.WORKOS_AUTHKIT_DOMAIN
    ?? null;
}

export function getMcpAuthConfig(): McpAuthConfig {
  const authorizationServer = getMcpAuthorizationServer();
  const anonymousEnabled = process.env.MCP_ENABLE_ANONYMOUS_OAUTH === "1" || Boolean(authorizationServer);
  if (!authorizationServer && !anonymousEnabled) {
    return {
      enabled: false,
      anonymousEnabled: false,
      authorizationServer: null,
      jwks: null,
    };
  }

  const jwks = authorizationServer
    ? createRemoteJWKSet(new URL("/oauth2/jwks", authorizationServer))
    : null;

  return {
    enabled: true,
    anonymousEnabled,
    authorizationServer,
    jwks,
  };
}

export function isAnonymousSessionId(sessionId?: string): boolean {
  if (!sessionId) return false;
  return sessionId.startsWith("anon_session_") || sessionId.startsWith("mcp_");
}

export function selectMcpAuthProvider(
  request: Request,
  config: McpAuthConfig,
): "workos" | "anonymous" | null {
  if (!config.enabled) {
    return null;
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  if (config.anonymousEnabled && isAnonymousSessionId(sessionId)) {
    return "anonymous";
  }

  if (config.authorizationServer) {
    return "workos";
  }

  if (config.anonymousEnabled) {
    return "anonymous";
  }

  return null;
}

export async function getAnonymousOAuthServer(
  ctx: ActionCtx,
  request: Request,
): Promise<AnonymousOAuthServer> {
  const issuer = new URL(request.url).origin;
  const server = new AnonymousOAuthServer({
    issuer,
    storage: new ActionOAuthStorage(ctx),
  });
  await server.init();
  return server;
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
  ctx: ActionCtx,
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
      // Fall through to anonymous-token verification.
    }
  }

  try {
    const anonymousOauthServer = await getAnonymousOAuthServer(ctx, request);
    const verified = await anonymousOauthServer.verifyToken(token);
    if (!verified || verified.provider !== "anonymous") {
      return null;
    }

    const workspaceClaim = verified.claims[ANON_WORKSPACE_CLAIM];
    const sessionClaim = verified.claims[ANON_SESSION_CLAIM];

    return {
      provider: "anonymous",
      subject: verified.sub,
      workspaceId: typeof workspaceClaim === "string" ? parseWorkspaceId(workspaceClaim) : undefined,
      sessionId: typeof sessionClaim === "string" ? sessionClaim : undefined,
    };
  } catch {
    return null;
  }
}

export function parseMcpContext(url: URL): ParsedMcpContext | undefined {
  const raw = url.searchParams.get("workspaceId");
  const workspaceId = raw ? parseWorkspaceId(raw) : undefined;
  const clientId = url.searchParams.get("clientId") ?? undefined;
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  if (!workspaceId && !clientId && !sessionId) {
    return undefined;
  }
  return { workspaceId, clientId, sessionId };
}

export function parseAnonymousAuthorizeContext(params: URLSearchParams): {
  workspaceId: Id<"workspaces">;
  sessionId: string;
} | null {
  const directWorkspaceId = params.get("workspaceId");
  const directSessionId = params.get("sessionId");
  if (directWorkspaceId && directSessionId && isAnonymousSessionId(directSessionId)) {
    return {
      workspaceId: parseWorkspaceId(directWorkspaceId),
      sessionId: directSessionId,
    };
  }

  const resource = params.get("resource");
  if (!resource) {
    return null;
  }

  try {
    const resourceUrl = new URL(resource);
    const workspaceId = resourceUrl.searchParams.get("workspaceId");
    const sessionId = resourceUrl.searchParams.get("sessionId");
    if (!workspaceId || !sessionId || !isAnonymousSessionId(sessionId)) {
      return null;
    }

    return {
      workspaceId: parseWorkspaceId(workspaceId),
      sessionId,
    };
  } catch {
    return null;
  }
}
