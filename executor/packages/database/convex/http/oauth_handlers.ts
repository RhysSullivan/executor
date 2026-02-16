import { httpAction } from "../_generated/server";
import { getMcpAuthConfig, MCP_ANONYMOUS_PATH, MCP_PATH, selectMcpAuthProvider } from "./mcp_auth";

export const oauthProtectedResourceHandler = httpAction(async (_ctx, request) => {
  const mcpAuthConfig = getMcpAuthConfig();
  const url = new URL(request.url);

  const provider = selectMcpAuthProvider(mcpAuthConfig);
  if (!provider || !mcpAuthConfig.authorizationServer) {
    return Response.json({ error: "MCP OAuth is not configured" }, { status: 404 });
  }

  let resource = new URL(MCP_PATH, url.origin);
  resource.search = url.search;
  const resourceHint = url.searchParams.get("resource");
  if (resourceHint) {
    try {
      const parsed = new URL(resourceHint);
      if (parsed.origin !== url.origin) {
        return Response.json({ error: "resource hint origin must match this server" }, { status: 400 });
      }

      if (parsed.pathname === MCP_ANONYMOUS_PATH) {
        return Response.json(
          { error: "Anonymous MCP does not use OAuth discovery" },
          { status: 404 },
        );
      }

      if (parsed.pathname === MCP_PATH) {
        resource = parsed;
      }
    } catch {
      return Response.json({ error: "Invalid resource hint" }, { status: 400 });
    }
  }

  return Response.json({
    resource: resource.toString(),
    authorization_servers: [mcpAuthConfig.authorizationServer],
    bearer_methods_supported: ["header"],
  });
});

export const oauthAuthorizationServerHandler = httpAction(async (_ctx, _request) => {
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
