import {
  createWorkosPrincipal,
  getControlPlaneRuntime,
  provisionPrincipal,
} from "../../../lib/control-plane/server";
import {
  getMcpAuthConfig,
  unauthorizedMcpResponse,
  verifyMcpBearerToken,
} from "../../../lib/mcp/resource-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const parseWorkspaceId = (request: Request): string | null => {
  const value = new URL(request.url).searchParams.get("workspaceId")?.trim();
  return value && value.length > 0 ? value : null;
};

const handler = async (request: Request): Promise<Response> => {
  const authConfig = getMcpAuthConfig();
  if (!authConfig.enabled) {
    return Response.json(
      {
        error:
          "MCP OAuth is not configured. Set MCP_AUTHORIZATION_SERVER (or WORKOS_AUTHKIT_ISSUER).",
      },
      { status: 503 },
    );
  }

  const verified = await verifyMcpBearerToken(request, authConfig);
  if (!verified) {
    return unauthorizedMcpResponse(request, "No valid bearer token provided.");
  }

  const workspaceId = parseWorkspaceId(request);
  if (!workspaceId) {
    return Response.json(
      { error: "workspaceId query parameter is required" },
      { status: 400 },
    );
  }

  const principal = createWorkosPrincipal({
    subject: verified.subject,
    email: verified.email,
    displayName: verified.displayName,
  });

  if (workspaceId !== principal.workspaceId) {
    return Response.json(
      { error: "workspaceId does not match authenticated subject" },
      { status: 403 },
    );
  }

  const controlPlaneRuntime = await getControlPlaneRuntime();
  await provisionPrincipal(controlPlaneRuntime, principal);

  return controlPlaneRuntime.handleMcp(request, workspaceId);
};

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
