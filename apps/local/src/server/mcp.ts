import { Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createExecutorMcpServer, type ExecutorMcpServerConfig } from "@executor/host-mcp";

// ---------------------------------------------------------------------------
// Streamable HTTP handler
// ---------------------------------------------------------------------------

export type McpRequestHandler = {
  readonly handleRequest: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
};

const jsonError = (status: number, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });

export const createMcpRequestHandler = (config: ExecutorMcpServerConfig): McpRequestHandler => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  const dispose = async (id: string, opts: { transport?: boolean; server?: boolean } = {}) => {
    const t = transports.get(id);
    const s = servers.get(id);
    transports.delete(id);
    servers.delete(id);
    if (opts.transport) await t?.close().catch(() => undefined);
    if (opts.server) await s?.close().catch(() => undefined);
  };

  return {
    handleRequest: async (request) => {
      const sessionId = request.headers.get("mcp-session-id");

      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) return jsonError(404, -32001, "Session not found");
        return transport.handleRequest(request);
      }

      let created: McpServer | undefined;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          if (created) servers.set(sid, created);
        },
        onsessionclosed: (sid) => void dispose(sid, { server: true }),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) void dispose(sid, { server: true });
      };

      try {
        created = await Effect.runPromise(createExecutorMcpServer(config));
        await created.connect(transport);
        const response = await transport.handleRequest(request);

        if (!transport.sessionId) {
          await transport.close().catch(() => undefined);
          await created.close().catch(() => undefined);
        }
        return response;
      } catch (error) {
        console.error("[mcp] handleRequest error:", error instanceof Error ? error.stack : error);
        if (!transport.sessionId) {
          await transport.close().catch(() => undefined);
          await created?.close().catch(() => undefined);
        }
        return jsonError(500, -32603, "Internal server error");
      }
    },

    close: async () => {
      const ids = new Set([...transports.keys(), ...servers.keys()]);
      await Promise.all([...ids].map((id) => dispose(id, { transport: true, server: true })));
    },
  };
};

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

export const runMcpStdioServer = async (config: ExecutorMcpServerConfig): Promise<void> => {
  const server = await Effect.runPromise(createExecutorMcpServer(config));
  const transport = new StdioServerTransport();

  const waitForExit = () =>
    new Promise<void>((resolve) => {
      const finish = () => {
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
        process.stdin.off("end", finish);
        process.stdin.off("close", finish);
        resolve();
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      process.stdin.once("end", finish);
      process.stdin.once("close", finish);
    });

  try {
    await server.connect(transport);
    await waitForExit();
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
};
