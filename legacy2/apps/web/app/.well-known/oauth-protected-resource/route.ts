import { externalOriginFromRequest } from "../../../lib/workos";
import { getMcpAuthConfig } from "../../../lib/mcp/resource-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MCP_PATH = "/v1/mcp";

const parseResourceHint = (
  requestUrl: URL,
  origin: string,
): { resourceUrl: URL } | { error: string } => {
  const resourceHint = requestUrl.searchParams.get("resource")?.trim();
  if (!resourceHint) {
    const fallback = new URL(MCP_PATH, origin);
    for (const [key, value] of requestUrl.searchParams.entries()) {
      if (key === "resource") continue;
      fallback.searchParams.set(key, value);
    }
    return { resourceUrl: fallback };
  }

  let parsed: URL;
  try {
    parsed = new URL(resourceHint);
  } catch {
    return { error: "Invalid resource hint" };
  }

  if (parsed.origin !== origin) {
    return { error: "resource hint origin must match this server" };
  }

  if (parsed.pathname !== MCP_PATH) {
    return { error: `resource hint path must be ${MCP_PATH}` };
  }

  return { resourceUrl: parsed };
};

export async function GET(request: Request): Promise<Response> {
  const authConfig = getMcpAuthConfig();
  if (!authConfig.enabled || !authConfig.authorizationServer) {
    return Response.json(
      { error: "MCP OAuth is not configured" },
      { status: 404 },
    );
  }

  const origin = externalOriginFromRequest(request);
  const requestUrl = new URL(request.url);
  const parsedResource = parseResourceHint(requestUrl, origin);
  if ("error" in parsedResource) {
    return Response.json({ error: parsedResource.error }, { status: 400 });
  }

  return Response.json({
    resource: parsedResource.resourceUrl.toString(),
    authorization_servers: [authConfig.authorizationServer],
    bearer_methods_supported: ["header"],
  });
}
