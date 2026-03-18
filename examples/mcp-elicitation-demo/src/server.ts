import { randomUUID } from "node:crypto";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";

export type McpElicitationDemoServer = {
  readonly endpoint: string;
  readonly close: () => Promise<void>;
};

const registerDemoTools = (server: McpServer) => {
  server.registerTool(
    "gated_echo",
    {
      description: "Ask for approval before echoing the provided value.",
      inputSchema: {
        value: z.string(),
      },
    },
    async ({ value }: { value: string }) => {
      const response = await server.server.elicitInput({
        mode: "form",
        message: `Approve gated echo for ${value}?`,
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve",
            },
          },
          required: ["approve"],
        },
      });

      if (
        response.action !== "accept"
        || !response.content
        || response.content.approve !== true
      ) {
        return {
          content: [{ type: "text", text: "denied" }],
        };
      }

      return {
        content: [{ type: "text", text: `approved:${value}` }],
      };
    },
  );
};

export const startMcpElicitationDemoServer = async (input: {
  readonly host?: string;
  readonly port?: number;
} = {}): Promise<McpElicitationDemoServer> => {
  const host = input.host ?? "127.0.0.1";
  const app = createMcpExpressApp({ host });
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const servers: Record<string, McpServer> = {};

  const createServer = () => {
    const server = new McpServer(
      {
        name: "executor-mcp-elicitation-demo",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    registerDemoTools(server);
    return server;
  };

  app.post("/mcp", async (req: any, res: any) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId =
      typeof sessionIdHeader === "string"
        ? sessionIdHeader
        : Array.isArray(sessionIdHeader)
          ? sessionIdHeader[0]
          : undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport;
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId && transports[closedSessionId]) {
            delete transports[closedSessionId];
          }
          if (closedSessionId && servers[closedSessionId]) {
            void servers[closedSessionId].close().catch(() => undefined);
            delete servers[closedSessionId];
          }
        };

        const server = createServer();
        await server.connect(transport);
        const newSessionId = transport.sessionId;
        if (newSessionId) {
          servers[newSessionId] = server;
        }
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (req: any, res: any) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId =
      typeof sessionIdHeader === "string"
        ? sessionIdHeader
        : Array.isArray(sessionIdHeader)
          ? sessionIdHeader[0]
          : undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", async (req: any, res: any) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId =
      typeof sessionIdHeader === "string"
        ? sessionIdHeader
        : Array.isArray(sessionIdHeader)
          ? sessionIdHeader[0]
          : undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res, req.body);
    await transport.close();
    delete transports[sessionId];

    if (servers[sessionId]) {
      await servers[sessionId].close().catch(() => undefined);
      delete servers[sessionId];
    }
  });

  const listener = await new Promise<import("node:http").Server>((resolve, reject) => {
    const server = app.listen(input.port ?? 0, host);

    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };

    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };

    server.once("listening", onListening);
    server.once("error", onError);
  });

  const address = listener.address();
  if (!address || typeof address === "string") {
    if (listener.listening) {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
    throw new Error("Failed to resolve MCP elicitation demo server address");
  }

  return {
    endpoint: `http://${host}:${address.port}/mcp`,
    close: async () => {
      for (const transport of Object.values(transports)) {
        await transport.close().catch(() => undefined);
      }

      for (const server of Object.values(servers)) {
        await server.close().catch(() => undefined);
      }

      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
};
