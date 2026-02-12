import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { OAuthBadRequest } from "../../core/src/anonymous-oauth";
import {
  ANON_SESSION_CLAIM,
  ANON_WORKSPACE_CLAIM,
  getAnonymousOAuthServer,
  getMcpAuthConfig,
  isAnonymousSessionId,
  parseAnonymousAuthorizeContext,
  selectMcpAuthProvider,
} from "./mcp_auth";

export const oauthProtectedResourceHandler = httpAction(async (_ctx, request) => {
  const mcpAuthConfig = getMcpAuthConfig();
  const url = new URL(request.url);

  let resource = new URL("/mcp", url.origin);
  resource.search = url.search;
  const resourceHint = url.searchParams.get("resource");
  if (resourceHint) {
    try {
      const parsed = new URL(resourceHint);
      if (parsed.origin === url.origin && parsed.pathname === "/mcp") {
        resource = parsed;
      }
    } catch {
      // Ignore malformed resource hint and fall back to request URL params.
    }
  }

  let provider = selectMcpAuthProvider(request, mcpAuthConfig);
  const hintedSessionId = resource.searchParams.get("sessionId") ?? undefined;
  const hintedWorkspaceId = resource.searchParams.get("workspaceId") ?? undefined;

  if (mcpAuthConfig.anonymousEnabled && isAnonymousSessionId(hintedSessionId)) {
    provider = "anonymous";
  }

  if (!provider && mcpAuthConfig.anonymousEnabled) {
    provider = "anonymous";
  }

  if (provider === "workos" && !hintedWorkspaceId && mcpAuthConfig.anonymousEnabled) {
    // Queryless discovery calls are ambiguous; prefer anonymous so clients
    // can discover a first-party auth server without being redirected to WorkOS.
    provider = "anonymous";
  }

  if (!provider) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  const authorizationServer = provider === "anonymous"
    ? url.origin
    : mcpAuthConfig.authorizationServer;

  if (!authorizationServer) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  return Response.json({
    resource: resource.toString(),
    authorization_servers: [authorizationServer],
    bearer_methods_supported: ["header"],
  });
});

export const oauthAuthorizationServerHandler = httpAction(async (_ctx, request) => {
  const mcpAuthConfig = getMcpAuthConfig();
  if (!mcpAuthConfig.enabled) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  // Clients usually call this endpoint without workspace/session params.
  // When anonymous OAuth is enabled, default to our self-issued metadata.
  if (mcpAuthConfig.anonymousEnabled) {
    const oauthServer = await getAnonymousOAuthServer(_ctx, request);
    return Response.json(oauthServer.getMetadata());
  }

  if (!mcpAuthConfig.authorizationServer) {
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

export const oauthJwksHandler = httpAction(async (_ctx, request) => {
  const mcpAuthConfig = getMcpAuthConfig();
  if (!mcpAuthConfig.enabled) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  const oauthServer = await getAnonymousOAuthServer(_ctx, request);
  return Response.json(oauthServer.getJwks(), {
    headers: {
      "cache-control": "public, max-age=3600",
    },
  });
});

export const oauthRegisterHandler = httpAction(async (_ctx, request) => {
  const mcpAuthConfig = getMcpAuthConfig();
  if (!mcpAuthConfig.enabled) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  let body: { redirect_uris?: string[]; client_name?: string };
  try {
    body = await request.json() as { redirect_uris?: string[]; client_name?: string };
  } catch {
    return Response.json({ error: "invalid_client_metadata", error_description: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const oauthServer = await getAnonymousOAuthServer(_ctx, request);
    const registration = await oauthServer.registerClient(body);
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
});

export const oauthAuthorizeHandler = httpAction(async (ctx, request) => {
  const mcpAuthConfig = getMcpAuthConfig();
  if (!mcpAuthConfig.enabled) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  const oauthServer = await getAnonymousOAuthServer(ctx, request);
  const url = new URL(request.url);
  const anonymousContext = parseAnonymousAuthorizeContext(url.searchParams);

  try {
    if (!anonymousContext) {
      throw new OAuthBadRequest("resource must include workspaceId and anonymous sessionId");
    }

    const access = await ctx.runQuery(internal.workspaceAuthInternal.getWorkspaceAccessForRequest, {
      workspaceId: anonymousContext.workspaceId,
      sessionId: anonymousContext.sessionId,
    });

    if (access.provider !== "anonymous") {
      throw new OAuthBadRequest("Anonymous OAuth requires an anonymous session");
    }

    const { redirectTo } = await oauthServer.authorize(url.searchParams, {
      actorId: access.actorId,
      tokenClaims: {
        [ANON_WORKSPACE_CLAIM]: anonymousContext.workspaceId,
        [ANON_SESSION_CLAIM]: anonymousContext.sessionId,
      },
    });

    return Response.redirect(redirectTo, 302);
  } catch (error) {
    if (error instanceof OAuthBadRequest) {
      return Response.json(
        { error: "invalid_request", error_description: error.message },
        { status: 400 },
      );
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Workspace authorization failed" },
      { status: 403 },
    );
  }
});

export const oauthTokenHandler = httpAction(async (_ctx, request) => {
  const mcpAuthConfig = getMcpAuthConfig();
  if (!mcpAuthConfig.enabled) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  try {
    const oauthServer = await getAnonymousOAuthServer(_ctx, request);
    const body = new URLSearchParams(await request.text());
    const tokens = await oauthServer.exchangeToken(body);
    return Response.json(tokens, {
      headers: {
        "cache-control": "no-store",
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
});
