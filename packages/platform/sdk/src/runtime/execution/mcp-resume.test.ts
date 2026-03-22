import { randomUUID } from "node:crypto";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { z } from "zod/v4";

import { makeToolInvokerFromTools } from "@executor/codemode-core";
import { discoverMcpToolsFromConnector } from "@executor/source-mcp";
import { makeDenoSubprocessExecutor } from "@executor/runtime-deno-subprocess";

import {
  type ResolveExecutionEnvironment,
} from "../index";
import { createLocalExecutorRuntime as createExecutorRuntime } from "../../../../sdk-file/src/index";
import { withExecutorApiClient } from "./test-http-client";

type McpFormServer = {
  endpoint: string;
  close: () => Promise<void>;
};

const registerFormGatedEchoTool = (server: McpServer) => {
  server.registerTool(
    "gated_echo",
    {
      description: "Asks for approval before echoing",
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

const makeFormElicitationServer = Effect.acquireRelease(
  Effect.promise<McpFormServer>(
    () =>
      new Promise<McpFormServer>((resolve, reject) => {
        const app = createMcpExpressApp({ host: "127.0.0.1" });
        const transports: Record<string, StreamableHTTPServerTransport> = {};
        const servers: Record<string, McpServer> = {};

        const createServer = () => {
          const server = new McpServer(
            {
              name: "control-plane-mcp-form-elicitation-test-server",
              version: "1.0.0",
            },
            {
              capabilities: {
                tools: {},
              },
            },
          );

          registerFormGatedEchoTool(server);
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

          if (servers[sessionId]) {
            await servers[sessionId].close().catch(() => undefined);
            delete servers[sessionId];
          }
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

              for (const server of Object.values(servers)) {
                await server.close().catch(() => undefined);
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
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(Effect.orDie),
);

const makeMcpExecutionResolver = (
  endpoint: string,
): ResolveExecutionEnvironment =>
  ({ onElicitation }) =>
    (Effect.gen(function* () {
      const discovered = yield* discoverMcpToolsFromConnector({
        connect: Effect.tryPromise({
          try: async () => {
            const client = new Client(
              {
                name: "control-plane-mcp-execution-client",
                version: "1.0.0",
              },
              { capabilities: { elicitation: { form: {} } } },
            );
            const transport = new StreamableHTTPClientTransport(new URL(endpoint));
            await client.connect(transport);

            return {
              client,
              close: async () => {
                await client.close();
              },
            };
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
        namespace: "source.form",
        sourceKey: "mcp.form",
      });

        return {
          executor: makeDenoSubprocessExecutor(),
          toolInvoker: makeToolInvokerFromTools({
            tools: discovered.tools,
            onElicitation,
          }),
        };
    }) as Effect.Effect<
      {
        executor: ReturnType<typeof makeDenoSubprocessExecutor>;
        toolInvoker: ReturnType<typeof makeToolInvokerFromTools>;
      },
      unknown
    >);

describe("execution-mcp-resume", () => {
  it.scoped("keeps live form elicitation resumable without replaying the run", () =>
    Effect.gen(function* () {
      const mcpServer = yield* makeFormElicitationServer;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectory({
        directory: tmpdir(),
        prefix: "executor-execution-mcp-resume-",
      });
      const runtime = yield* Effect.acquireRelease(
        createExecutorRuntime({
          localDataDir: ":memory:",
          workspaceRoot,
          homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
          homeStateDirectory: join(workspaceRoot, ".executor-home-state"),
          executionResolver: makeMcpExecutionResolver(mcpServer.endpoint),
        }),
        (runtime) => Effect.promise(() => runtime.close()).pipe(Effect.orDie),
      );

      const installation = runtime.localInstallation;

      const created = yield* withExecutorApiClient(
        {
          runtime,
          accountId: installation.accountId,
        },
        (client) =>
          client.executions.create({
            path: {
              workspaceId: installation.workspaceId,
            },
            payload: {
              code: 'return await tools.source.form.gated_echo({ value: "from-control-plane" });',
              interactionMode: "live_form",
            },
          }),
      );

      expect(created.execution.status).toBe("waiting_for_interaction");
      expect(created.pendingInteraction).not.toBeNull();
      if (created.pendingInteraction !== null) {
        expect(created.pendingInteraction.kind).toBe("form");
        expect(created.pendingInteraction.payloadJson).toContain("Approve gated echo");
      }

      const pendingInteraction = yield* runtime.storage.executorState.executionInteractions.getPendingByExecutionId(
        created.execution.id,
      );

      assertTrue(Option.isSome(pendingInteraction));
      if (Option.isSome(pendingInteraction)) {
        expect(pendingInteraction.value.kind).toBe("form");
        expect(pendingInteraction.value.payloadJson).toContain("Approve gated echo");
      }

      const resumed = yield* withExecutorApiClient(
        {
          runtime,
          accountId: installation.accountId,
        },
        (client) =>
          client.executions.resume({
            path: {
              workspaceId: installation.workspaceId,
              executionId: created.execution.id,
            },
            payload: {
              interactionMode: "live_form",
              responseJson: JSON.stringify({
                action: "accept",
                content: {
                  approve: true,
                },
              }),
            },
          }),
      );
      expect(resumed.execution.status).toBe("completed");
      expect(resumed.pendingInteraction).toBeNull();
      expect(resumed.execution.resultJson).toContain("approved:from-control-plane");

    }).pipe(Effect.provide(NodeFileSystem.layer)),
    60_000,
  );
});
