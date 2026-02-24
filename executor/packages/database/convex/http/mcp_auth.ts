import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Id } from "../_generated/dataModel.d.ts";
import type { ActionCtx } from "../_generated/server";

export const MCP_PATH = "/v1/mcp";
export const MCP_ANONYMOUS_PATH = "/v1/mcp/anonymous";
export const LEGACY_MCP_PATH = "/mcp";
export const LEGACY_MCP_ANONYMOUS_PATH = "/mcp/anonymous";

type McpAuthConfig = {
  required: boolean;
  enabled: boolean;
  authorizationServer: string | null;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
};

type VerifiedMcpToken = { provider: "workos"; subject: string };

type ParsedMcpContext = {
  workspaceId?: Id<"workspaces">;
};

function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function mcpAuthRequired(): boolean {
  const explicit = (process.env.EXECUTOR_DEPLOYMENT_MODE ?? "").trim().toLowerCase();
  if (explicit === "cloud" || explicit === "hosted" || explicit === "production" || explicit === "prod") {
    return true;
  }

  if (explicit === "self-hosted" || explicit === "self_hosted" || explicit === "selfhosted") {
    return false;
  }

  return isTruthyEnvValue(process.env.EXECUTOR_ENFORCE_MCP_AUTH);
}

// WorkOS AuthKit tokens use the requesting MCP client's client ID as the
// audience, which varies per client. Per WorkOS docs, only issuer + signature
// verification is required — audience checks are intentionally omitted.

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
  const required = mcpAuthRequired();
  const authorizationServer = getMcpAuthorizationServer();
  if (!authorizationServer) {
    return {
      required,
      enabled: false,
      authorizationServer: null,
      jwks: null,
    };
  }

  const jwks = authorizationServer
    ? createRemoteJWKSet(new URL("/oauth2/jwks", authorizationServer))
    : null;

  return {
    required,
    enabled: true,
    authorizationServer,
    jwks,
  };
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
    } catch (error) {
      console.error("MCP token verification failed:", error instanceof Error ? error.message : String(error));
    }
  }

  return null;
}

export function parseMcpContext(url: URL): ParsedMcpContext | undefined {
  const raw = url.searchParams.get("workspaceId");
  const workspaceId = raw ? parseWorkspaceId(raw) : undefined;
  if (!workspaceId) {
    return undefined;
  }
  return { workspaceId };
}
