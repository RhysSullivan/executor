import { randomUUID } from "node:crypto";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { z } from "zod/v4";

import { makeToolInvokerFromTools } from "@executor/codemode-core";
import { makeSesExecutor } from "@executor/runtime-ses";

import { createSdkMcpConnector } from "./mcp-connection";
import { discoverMcpToolsFromConnector } from "./mcp-tools";

type UrlMcpServer = {
  endpoint: string;
  close: () => Promise<void>;
};

const registerBlockingUrlTool = (server: McpServer) => {
  server.registerTool(
    "url_blocking_echo",
    {
      description: "Requests URL elicitation and continues after accept",
      inputSchema: {
        value: z.string(),
      },
    },
    async ({ value }: { value: string }) => {
      const response = await server.server.elicitInput({
        mode: "url",
        message: `Open the URL to approve ${value}`,
        url: `https://example.com/approve?value=${encodeURIComponent(value)}`,
        elicitationId: `blocking-${value}`,
      });

      if (response.action !== "accept") {
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

const registerNonBlockingUrlTool = (server: McpServer) => {
  const seenValues = new Set<string>();

  server.registerTool(
    "url_retry_echo",
    {
      description: "Throws URL elicitation required once, then succeeds",
      inputSchema: {
        value: z.string(),
      },
    },
    async ({ value }: { value: string }) => {
      if (!seenValues.has(value)) {
        seenValues.add(value);

        throw new UrlElicitationRequiredError([
          {
            mode: "url",
            message: `Authorize and then retry for ${value}`,
            url: `https://example.com/retry?value=${encodeURIComponent(value)}`,
            elicitationId: `retry-${value}`,
          },
        ]);
      }

      return {
        content: [{ type: "text", text: `approved-after-retry:${value}` }],
      };
    },
  );
};

const makeUrlElicitationServer = (mode: "blocking" | "non_blocking") =>
  Effect.acquireRelease(
    Effect.promise<UrlMcpServer>(
      () =>
        new Promise<UrlMcpServer>((resolve, reject) => {
          const app = createMcpExpressApp({ host: "127.0.0.1" });
          const transports: Record<string, StreamableHTTPServerTransport> = {};

          const createServer = () => {
            const server = new McpServer(
              {
                name: `codemode-mcp-url-${mode}-test-server`,
                version: "1.0.0",
              },
              {
                capabilities: {
                  tools: {},
                },
              },
            );

            if (mode === "blocking") {
              registerBlockingUrlTool(server);
            } else {
              registerNonBlockingUrlTool(server);
            }

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
                };

                const server = createServer();
                await server.connect(transport);
              }

              await transport.handleRequest(req, res, req.body);
            } catch (error) {
              if (!res.headersSent) {
                res.status(500).json({
                  jsonrpc: "2.0",
                  error: {
                    code: -32603,
                    message:
                      error instanceof Error ? error.message : "Internal server error",
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
          });

          const listener = app.listen(0, "127.0.0.1", () => {
            const address = listener.address();
            if (!address || typeof address === "string") {
              reject(new Error("failed to resolve MCP test server address"));
              return;
            }

            resolve({
              endpoint: `http://127.0.0.1:${address.port}/mcp`,
              close: async () => {
                for (const transport of Object.values(transports)) {
                  await transport.close().catch(() => undefined);
                }

                await new Promise<void>((closeResolve, closeReject) => {
                  listener.close((error: Error | undefined) => {
                    if (error) {
                      closeReject(error);
                      return;
                    }
                    closeResolve();
                  });
                });
              },
            });
          });

          listener.once("error", reject);
        }),
    ),
    (server: UrlMcpServer) =>
      Effect.tryPromise({
        try: () => server.close(),
        catch: (error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.orDie),
  );

describe("codemode-mcp URL elicitation", () => {
  it.scoped("supports blocking URL mode elicitation from URL source", () =>
    Effect.gen(function* () {
      const server = yield* makeUrlElicitationServer("blocking");
      const elicitations: Array<{ mode: string | undefined; message: string }> = [];

      const discovered = yield* discoverMcpToolsFromConnector({
        connect: createSdkMcpConnector({
          endpoint: server.endpoint,
          transport: "streamable-http",
        }),
        namespace: "source.url",
        sourceKey: "mcp.url",
      });

      const output = yield* makeSesExecutor().execute(
        'return await tools.source.url.url_blocking_echo({ value: "from-url-blocking" });',
        makeToolInvokerFromTools({
          tools: discovered.tools,
          onElicitation: ({ elicitation }) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                elicitations.push({
                  mode: elicitation.mode,
                  message: elicitation.message,
                });
              });

              return {
                action: "accept" as const,
              };
            }),
        }),
      );

      expect(output.result).toEqual({
        content: [{ type: "text", text: "approved:from-url-blocking" }],
      });
      expect(elicitations).toHaveLength(1);
      expect(elicitations[0].mode).toBe("url");
      expect(elicitations[0].message).toContain("Open the URL to approve from-url-blocking");
    }),
  );

  it.scoped("supports non-blocking URL mode retry when server returns URL required error", () =>
    Effect.gen(function* () {
      const server = yield* makeUrlElicitationServer("non_blocking");
      const elicitations: Array<{ mode: string | undefined; message: string }> = [];

      const discovered = yield* discoverMcpToolsFromConnector({
        connect: createSdkMcpConnector({
          endpoint: server.endpoint,
          transport: "streamable-http",
        }),
        namespace: "source.url",
        sourceKey: "mcp.url",
      });

      const output = yield* makeSesExecutor().execute(
        'return await tools.source.url.url_retry_echo({ value: "from-url-retry" });',
        makeToolInvokerFromTools({
          tools: discovered.tools,
          onElicitation: ({ elicitation }) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                elicitations.push({
                  mode: elicitation.mode,
                  message: elicitation.message,
                });
              });

              return {
                action: "accept" as const,
              };
            }),
        }),
      );

      expect(output.result).toEqual({
        content: [{ type: "text", text: "approved-after-retry:from-url-retry" }],
      });
      expect(elicitations).toHaveLength(1);
      expect(elicitations[0].mode).toBe("url");
      expect(elicitations[0].message).toContain("Authorize and then retry for from-url-retry");
    }),
  );
});
