import { handleMcpHttpRequest } from "@executor-v2/mcp-gateway";

const port = Number(Bun.env.PORT ?? 8787);

const handleMcp = async (request: Request): Promise<Response> =>
  handleMcpHttpRequest(request, {
    target: "local",
    serverName: "executor-v2-pm",
    serverVersion: "0.0.0",
  });

const server = Bun.serve({
  port,
  routes: {
    "/healthz": {
      GET: () => Response.json({ ok: true, service: "pm" }, { status: 200 }),
    },
    "/mcp": {
      GET: handleMcp,
      POST: handleMcp,
      DELETE: handleMcp,
    },
    "/v1/mcp": {
      GET: handleMcp,
      POST: handleMcp,
      DELETE: handleMcp,
    },
  },
});

console.log(`executor-v2 PM listening on http://127.0.0.1:${server.port}`);
