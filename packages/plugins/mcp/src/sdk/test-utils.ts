import { Effect } from "effect";
import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export type McpTestServer = {
  readonly url: string;
  readonly httpServer: http.Server;
  /** Number of MCP sessions created (each connect = 1 session) */
  readonly sessionCount: () => number;
};

/**
 * Spin up a real HTTP server backed by a fresh `McpServer` per session,
 * with proper session routing via `mcp-session-id`. The factory is invoked
 * once per new session, so tools registered inside it are isolated per
 * connection (matching the SDK's own server/transport coupling).
 */
export const serveMcpServer = (factory: () => McpServer) =>
  Effect.acquireRelease(
    Effect.callback<McpTestServer, Error>((resume) => {
      const transports = new Map<string, StreamableHTTPServerTransport>();
      let sessions = 0;

      const httpServer = http.createServer(async (req, res) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (sessionId) {
          const transport = transports.get(sessionId);
          if (!transport) {
            res.writeHead(404);
            res.end("Session not found");
            return;
          }
          await transport.handleRequest(req, res);
          return;
        }

        const mcpServer = factory();
        sessions++;

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
        });

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      });

      httpServer.listen(0, () => {
        const addr = httpServer.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}`,
            httpServer,
            sessionCount: () => sessions,
          }),
        );
      });
    }),
    ({ httpServer }) =>
      Effect.sync(() => {
        httpServer.close();
      }),
  );
