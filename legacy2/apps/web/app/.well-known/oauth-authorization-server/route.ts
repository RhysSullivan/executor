import { getMcpAuthConfig } from "../../../lib/mcp/resource-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const authConfig = getMcpAuthConfig();
  if (!authConfig.enabled || !authConfig.authorizationServer) {
    return Response.json(
      { error: "MCP OAuth is not configured" },
      { status: 404 },
    );
  }

  const upstream = new URL(
    "/.well-known/oauth-authorization-server",
    authConfig.authorizationServer,
  );

  try {
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
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? `Failed to fetch upstream auth metadata: ${error.message}`
            : "Failed to fetch upstream auth metadata",
      },
      { status: 502 },
    );
  }
}
