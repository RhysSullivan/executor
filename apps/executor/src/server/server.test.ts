import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
  FileSystem,
} from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { startMcpElicitationDemoServer } from "@executor/mcp-elicitation-demo";
import { makeToolInvokerFromTools, toTool } from "@executor/codemode-core";
import {
  createControlPlaneClient,
  controlPlaneOpenApiSpec,
  type ControlPlaneClient,
  buildLocalSourceArtifact,
  catalogSyncResultFromMcpManifest,
  deriveLocalInstallation,
  type ResolveExecutionEnvironment,
  resolveLocalWorkspaceContext,
  SourceIdSchema,
  writeLocalSourceArtifact,
  writeProjectLocalExecutorConfig,
} from "@executor/control-plane";
import { makeSesExecutor } from "@executor/runtime-ses";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";

import {
  seedDemoMcpSourceInWorkspace,
  seedGithubOpenApiSourceInWorkspace,
} from "../cli/dev";
import { createLocalExecutorServer } from "@executor/server";

const executionResolver: ResolveExecutionEnvironment = () =>
  Effect.succeed({
    executor: makeSesExecutor(),
    toolInvoker: makeToolInvokerFromTools({
      tools: {
        "math.add": {
          description: "Add two numbers",
          inputSchema: Schema.standardSchemaV1(
            Schema.Struct({
              a: Schema.optional(Schema.Number),
              b: Schema.optional(Schema.Number),
            }),
          ),
          execute: ({ a, b }) => ({ sum: (a ?? 0) + (b ?? 0) }),
        },
      },
    }),
  });

const makeTempWorkspaceRoot = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "executor-server-test-" })),
    Effect.provide(NodeFileSystem.layer),
  );

const createIsolatedLocalExecutorServer = (
  options: Parameters<typeof createLocalExecutorServer>[0] = {},
) =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeTempWorkspaceRoot();
    const server = yield* createLocalExecutorServer({
      ...options,
      workspaceRoot,
    });
    return {
      ...server,
      workspaceRoot,
    };
  });

const writeConfiguredLocalMcpSource = (input: {
  workspaceRoot: string;
  sourceId: string;
  endpoint: string;
  name?: string;
  namespace?: string;
}) =>
  Effect.gen(function* () {
    const sourceId = SourceIdSchema.make(input.sourceId);
    const context = yield* resolveLocalWorkspaceContext({
      workspaceRoot: input.workspaceRoot,
    });
    const installation = deriveLocalInstallation(context);

    yield* writeProjectLocalExecutorConfig({
      context,
      config: {
        sources: {
          [input.sourceId]: {
            kind: "mcp",
            name: input.name ?? "Demo",
            namespace: input.namespace ?? input.sourceId,
            connection: {
              endpoint: input.endpoint,
            },
            binding: {
              transport: "streamable-http",
            },
          },
        },
      },
    });

    const source = {
      id: sourceId,
      workspaceId: installation.workspaceId,
      name: input.name ?? "Demo",
      kind: "mcp" as const,
      endpoint: input.endpoint,
      status: "connected" as const,
      enabled: true,
      namespace: input.namespace ?? input.sourceId,
      bindingVersion: 1,
      binding: {
        transport: "streamable-http",
        queryParams: null,
        headers: null,
      },
      importAuthPolicy: "reuse_runtime" as const,
      importAuth: { kind: "none" as const },
      auth: { kind: "none" as const },
      sourceHash: null,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const syncResult = catalogSyncResultFromMcpManifest({
      source,
      endpoint: input.endpoint,
      manifest: {
        version: 2,
        server: null,
        tools: [{
          toolId: "gated_echo",
          toolName: "gated_echo",
          description: "Asks for approval before echoing a value",
          inputSchema: {
            type: "object",
            properties: {
              value: {
                type: "string",
              },
            },
            required: ["value"],
            additionalProperties: false,
          },
        }],
      },
    });

    yield* writeLocalSourceArtifact({
      context,
      sourceId,
      artifact: buildLocalSourceArtifact({
        source,
        syncResult,
      }),
    });
  }).pipe(Effect.provide(NodeFileSystem.layer));

const makeServer = createIsolatedLocalExecutorServer({
  port: 0,
  localDataDir: ":memory:",
  executionResolver,
});

const gatedExecutionResolver: ResolveExecutionEnvironment = ({ onElicitation }) =>
  Effect.succeed({
    executor: makeSesExecutor(),
    toolInvoker: makeToolInvokerFromTools({
      tools: {
        "demo.gated_echo": toTool({
          tool: {
            description: "Asks for approval before echoing a value",
            inputSchema: Schema.standardSchemaV1(
              Schema.Struct({
                value: Schema.String,
                approve: Schema.optional(Schema.Boolean),
              }),
            ),
            execute: ({ value, approve }: { value: string; approve?: boolean }) =>
              approve === true ? `approved:${value}` : `denied:${value}`,
          },
          metadata: {
            sourceKey: "demo",
            elicitation: {
              mode: "form",
              message: "Approve gated echo?",
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
            },
          },
        }),
      },
      onElicitation,
    }),
  });

type ExecutorMcpClient = {
  client: Client;
  close: () => Promise<void>;
};

type ElicitationHandler = NonNullable<Parameters<Client["setRequestHandler"]>[1]>;

const makeExecutorMcpClient = (input: {
  baseUrl: string;
  capabilities?: Record<string, unknown>;
  onElicitation?: ElicitationHandler;
}) =>
  Effect.acquireRelease(
    Effect.promise<ExecutorMcpClient>(async () => {
      const client = new Client(
        { name: "executor-mcp-test-client", version: "1.0.0" },
        { capabilities: input.capabilities ?? {} },
      );
      if (input.onElicitation) {
        client.setRequestHandler(ElicitRequestSchema, input.onElicitation);
      }

      const transport = new StreamableHTTPClientTransport(new URL(`${input.baseUrl}/mcp`));
      await client.connect(transport);

      return {
        client,
        close: async () => {
          await client.close();
        },
      };
    }),
    ({ close }) => Effect.promise(() => close()).pipe(Effect.orDie),
  );

const ownerParam = HttpApiSchema.param("owner", Schema.String);
const repoParam = HttpApiSchema.param("repo", Schema.String);

class ExecutorDemoReposApi extends HttpApiGroup.make("repos")
  .add(
    HttpApiEndpoint.get("getRepo")`/repos/${ownerParam}/${repoParam}`
      .addSuccess(
        Schema.Struct({
          full_name: Schema.String,
          private: Schema.Boolean,
        }),
      ),
  )
{}

class ExecutorDemoApi extends HttpApi.make("executorDemo").add(ExecutorDemoReposApi) {}

const executorDemoOpenApiSpec = OpenApi.fromApi(ExecutorDemoApi);

const startOpenApiDemoServer = async () => {
  const seenAuthHeaders: Array<string | null> = [];

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/openapi.json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(executorDemoOpenApiSpec));
      return;
    }

    const match = req.url?.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && match) {
      seenAuthHeaders.push(
        typeof req.headers.authorization === "string" ? req.headers.authorization : null,
      );
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          full_name: `${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`,
          private: false,
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  };

  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind OpenAPI demo server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    specUrl: `http://127.0.0.1:${address.port}/openapi.json`,
    seenAuthHeaders,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const startMutatingOpenApiDemoServer = async () => {
  const createdBodies: Array<Record<string, unknown>> = [];
  const openApiDocument = JSON.stringify({
    openapi: "3.0.3",
    info: {
      title: "Executor DNS Demo API",
      version: "1.0.0",
    },
    paths: {
      "/records": {
        post: {
          operationId: "records.createRecord",
          tags: ["records"],
          summary: "Create a DNS record",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    name: { type: "string" },
                    value: { type: "string" },
                  },
                  required: ["type", "value"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "ok",
            },
          },
        },
      },
    },
  });

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/openapi.json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(openApiDocument);
      return;
    }

    if (req.method === "POST" && req.url === "/records") {
      const chunks: Array<Buffer> = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        createdBodies.push(parsed);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          ok: true,
          id: `rec_${createdBodies.length}`,
          record: parsed,
        }));
      });
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  };

  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mutating OpenAPI demo server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    specUrl: `http://127.0.0.1:${address.port}/openapi.json`,
    createdBodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const DEMO_OAUTH_ACCESS_TOKEN = "demo-access-token";
const DEMO_OAUTH_REFRESH_TOKEN = "demo-refresh-token";

const startOAuthProtectedMcpServer = async () => {
  const host = "127.0.0.1";
  const app = createMcpExpressApp({ host });
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const servers: Record<string, McpServer> = {};

  const createAuthorizedServer = () => {
    const server = new McpServer(
      {
        name: "executor-oauth-mcp-demo",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    server.registerTool(
      "whoami",
      {
        description: "Return the active identity for the OAuth demo source.",
        inputSchema: {},
      },
      async () => ({
        content: [{ type: "text", text: "oauth-demo" }],
      }),
    );

    return server;
  };

  const listener = await new Promise<import("node:http").Server>((resolve, reject) => {
    const server = app.listen(0, host);

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
    throw new Error("Failed to bind OAuth MCP demo server");
  }

  const baseUrl = `http://${host}:${address.port}`;
  const endpoint = `${baseUrl}/mcp`;
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;

  const requireBearerAuth = (req: IncomingMessage, res: ServerResponse) => {
    const authorization = req.headers.authorization;
    if (authorization === `Bearer ${DEMO_OAUTH_ACCESS_TOKEN}`) {
      return true;
    }

    res.statusCode = 401;
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${resourceMetadataUrl}"`,
    );
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: "unauthorized",
      }),
    );
    return false;
  };

  app.get("/.well-known/oauth-protected-resource/mcp", (_req: any, res: any) => {
    res.status(200).json({
      resource: endpoint,
      authorization_servers: [baseUrl],
      scopes_supported: ["openid", "offline_access"],
      bearer_methods_supported: ["header"],
    });
  });

  app.get("/.well-known/oauth-authorization-server", (_req: any, res: any) => {
    res.status(200).json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  app.post("/register", (req: any, res: any) => {
    res.status(201).json({
      ...(req.body ?? {}),
      client_id: `client_${randomUUID()}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });

  app.get("/authorize", (req: any, res: any) => {
    const redirectUri = new URL(String(req.query.redirect_uri));
    redirectUri.searchParams.set("code", "demo-code");
    if (typeof req.query.state === "string") {
      redirectUri.searchParams.set("state", req.query.state);
    }

    res.redirect(302, redirectUri.toString());
  });

  app.post("/token", (_req: any, res: any) => {
    res.status(200).json({
      access_token: DEMO_OAUTH_ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: DEMO_OAUTH_REFRESH_TOKEN,
      scope: "openid offline_access",
    });
  });

  app.post("/mcp", async (req: any, res: any) => {
    if (!requireBearerAuth(req, res)) {
      return;
    }

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

        const server = createAuthorizedServer();
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
    if (!requireBearerAuth(req, res)) {
      return;
    }

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
    if (!requireBearerAuth(req, res)) {
      return;
    }

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

  return {
    baseUrl,
    endpoint,
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

const extractUrlInteractionUrl = (payloadJson: string): string => {
  const parsed = JSON.parse(payloadJson) as {
    elicitation?: {
      url?: string;
    };
  };

  const url = parsed.elicitation?.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error("Missing URL elicitation in payloadJson");
  }

  return url;
};

describe("local-executor-server", () => {
  it.scoped("serves the control-plane OpenAPI spec at /v1/openapi.json", () =>
    Effect.gen(function* () {
      const server = yield* makeServer;
      const response = yield* Effect.promise(() =>
        fetch(`${server.baseUrl}/v1/openapi.json`, {
          headers: {
            accept: "application/json",
          },
        }),
      );
      const spec = yield* Effect.promise(() => response.json());

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(spec).toEqual(controlPlaneOpenApiSpec);
    }),
  );

  it.scoped("serves the control-plane API and executes code", () =>
    Effect.gen(function* () {
      const server = yield* makeServer;
      const bootstrapClient = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      const execution = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: "return await tools.math.add({ a: 20, b: 22 });",
        },
      });

      expect(execution.execution.status).toBe("completed");
      expect(execution.execution.resultJson).toBe(JSON.stringify({ sum: 42 }));
    }),
    15_000,
  );

  it.scoped("includes completed MCP return values in text content", () =>
    Effect.gen(function* () {
      const server = yield* makeServer;
      const mcp = yield* makeExecutorMcpClient({
        baseUrl: server.baseUrl,
      });

      const executed = yield* Effect.promise(
        () =>
          mcp.client.callTool({
            name: "execute",
            arguments: {
              code: "return await tools.math.add({ a: 20, b: 22 });",
            },
          }) as Promise<{
            content?: Array<{
              type?: string;
              text?: string;
            }>;
            structuredContent?: {
              status?: string;
              result?: unknown;
            };
          }>,
      );

      expect(executed.structuredContent?.status).toBe("completed");
      expect(executed.structuredContent?.result).toEqual({ sum: 42 });
      expect(executed.content?.find((item) => item.type === "text")?.text).toContain("Result:");
      expect(executed.content?.find((item) => item.type === "text")?.text).toContain('"sum": 42');
    }),
  );

  it.scoped("serves only execute over MCP when elicitation is supported", () =>
    Effect.gen(function* () {
      const server = yield* createIsolatedLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
        executionResolver: gatedExecutionResolver,
      });
      const mcp = yield* makeExecutorMcpClient({
        baseUrl: server.baseUrl,
        capabilities: {
          elicitation: {
            form: {},
            url: {},
          },
        },
        onElicitation: async () => ({
          action: "accept",
          content: {
            approve: true,
          },
        }),
      });

      const listed = yield* Effect.promise(
        () => mcp.client.listTools() as Promise<{ tools: Array<{ name: string; description?: string }> }>,
      );
      expect(listed.tools.map((tool) => tool.name)).toEqual(["execute"]);
      expect(listed.tools[0]?.description).toContain("Workflow:");
      expect(listed.tools[0]?.description).toContain("tools.discover");
      expect(listed.tools[0]?.description).toContain("tools.executor.sources.add");


      const executed = yield* Effect.promise(
        () =>
          mcp.client.callTool({
            name: "execute",
            arguments: {
              code: 'return await tools.demo.gated_echo({ value: "from-mcp" });',
            },
          }) as Promise<{
            content?: Array<{
              type?: string;
              text?: string;
            }>;
            structuredContent?: {
              status?: string;
              result?: unknown;
            };
          }>,
      );

      expect(executed.structuredContent?.status).toBe("completed");
      expect(executed.structuredContent?.result).toBe("approved:from-mcp");
      expect(executed.content?.find((item) => item.type === "text")?.text).toContain("approved:from-mcp");
    }),
  );

  it.scoped("serves execute and resume over MCP when elicitation is unavailable", () =>
    Effect.gen(function* () {
      const server = yield* createIsolatedLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
        executionResolver: gatedExecutionResolver,
      });
      const mcp = yield* makeExecutorMcpClient({
        baseUrl: server.baseUrl,
      });

      const listed = yield* Effect.promise(
        () => mcp.client.listTools() as Promise<{ tools: Array<{ name: string; description?: string }> }>,
      );
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["execute", "resume"]);
      expect(listed.tools.find((tool) => tool.name === "execute")?.description).toContain("Workflow:");
      expect(listed.tools.find((tool) => tool.name === "execute")?.description).toContain("tools.discover");


      const executed = yield* Effect.promise(
        () =>
          mcp.client.callTool({
            name: "execute",
            arguments: {
              code: 'return await tools.demo.gated_echo({ value: "manual-mcp" });',
            },
          }) as Promise<{
            structuredContent?: {
              status?: string;
              interaction?: {
                message?: string;
              };
              resumePayload?: {
                executionId?: string;
              };
            };
          }>,
      );

      expect(executed.structuredContent?.status).toBe("waiting_for_interaction");
      expect(executed.structuredContent?.interaction?.message).toContain("Approve gated echo");
      expect(executed.structuredContent?.resumePayload?.executionId).toBeTruthy();

      const resumed = yield* Effect.promise(
        () =>
          mcp.client.callTool({
            name: "resume",
            arguments: {
              resumePayload: executed.structuredContent?.resumePayload,
              response: {
                action: "accept",
                content: {
                  approve: true,
                },
              },
            },
          }) as Promise<{
            content?: Array<{
              type?: string;
              text?: string;
            }>;
            structuredContent?: {
              status?: string;
              result?: unknown;
            };
          }>,
      );

      expect(resumed.structuredContent?.status).toBe("completed");
      expect(resumed.structuredContent?.result).toBe("approved:manual-mcp");
      expect(resumed.content?.find((item) => item.type === "text")?.text).toContain("approved:manual-mcp");
    }),
    60_000,
  );

  it.scoped("loads MCP sources from control-plane state and resumes elicitation", () =>
    Effect.gen(function* () {
      const demoServer = yield* Effect.acquireRelease(
        Effect.promise(() => startMcpElicitationDemoServer()),
        (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
      );

      const server = yield* createIsolatedLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      yield* client.sources.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          name: "Demo",
          kind: "mcp",
          endpoint: demoServer.endpoint,
          status: "connected",
          enabled: true,
          namespace: "demo",
          binding: {
            transport: "streamable-http",
            queryParams: null,
            headers: null,
          },
          auth: {
            kind: "none",
          },
        },
      });

      const created = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: 'return await tools.demo.gated_echo({ value: "from-daemon" });',
          interactionMode: "live_form",
        },
      });

      expect(created.execution.status).toBe("waiting_for_interaction");
      expect(created.pendingInteraction).not.toBeNull();
      if (created.pendingInteraction !== null) {
        expect(created.pendingInteraction.kind).toBe("form");
        expect(created.pendingInteraction.payloadJson).toContain("Allow gated_echo?");
      }

      const approved = yield* client.executions.resume({
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
      });

      expect(approved.execution.status).toBe("waiting_for_interaction");
      expect(approved.pendingInteraction).not.toBeNull();
      if (approved.pendingInteraction !== null) {
        expect(approved.pendingInteraction.kind).toBe("form");
        expect(approved.pendingInteraction.payloadJson).toContain("Approve gated echo for from-daemon?");
      }

      const resumed = yield* client.executions.resume({
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
      });

      expect(resumed.execution.status).toBe("completed");
      expect(resumed.pendingInteraction).toBeNull();
      expect(resumed.execution.resultJson).toContain("approved:from-daemon");
    }),
  15_000,
  );

  it.scoped("can run the same MCP elicitation flow more than once without interaction id collisions", () =>
    Effect.gen(function* () {
      const demoServer = yield* Effect.acquireRelease(
        Effect.promise(() => startMcpElicitationDemoServer()),
        (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
      );

      const server = yield* createIsolatedLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      yield* client.sources.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          name: "Demo",
          kind: "mcp",
          endpoint: demoServer.endpoint,
          status: "connected",
          enabled: true,
          namespace: "demo",
          binding: {
            transport: "streamable-http",
            queryParams: null,
            headers: null,
          },
          auth: {
            kind: "none",
          },
        },
      });

      for (const value of ["first", "second"]) {
        const created = yield* client.executions.create({
          path: {
            workspaceId: installation.workspaceId,
          },
          payload: {
            code: `return await tools.demo.gated_echo({ value: "${value}" });`,
            interactionMode: "live_form",
          },
        });

        expect(created.execution.status).toBe("waiting_for_interaction");
        expect(created.pendingInteraction).not.toBeNull();

        const approved = yield* client.executions.resume({
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
        });

        expect(approved.execution.status).toBe("waiting_for_interaction");
        expect(approved.pendingInteraction).not.toBeNull();
        if (approved.pendingInteraction !== null) {
          expect(approved.pendingInteraction.kind).toBe("form");
          expect(approved.pendingInteraction.payloadJson).toContain(`Approve gated echo for ${value}?`);
        }

        const resumed = yield* client.executions.resume({
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
        });

        expect(resumed.execution.status).toBe("completed");
        expect(resumed.execution.resultJson).toContain(`approved:${value}`);
      }
    }),
    15_000,
  );

  it.scoped("does not create a duplicate when the demo MCP source already exists", () =>
    Effect.gen(function* () {
      const demoServer = yield* Effect.acquireRelease(
        Effect.promise(() => startMcpElicitationDemoServer()),
        (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
      );

      const server = yield* createIsolatedLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      const existing = yield* client.sources.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          name: "Demo",
          kind: "mcp",
          endpoint: demoServer.endpoint,
          status: "connected",
          enabled: true,
          namespace: "demo",
          binding: {
            transport: "streamable-http",
            queryParams: null,
            headers: null,
          },
          auth: {
            kind: "none",
          },
        },
      });

      const seeded = yield* seedDemoMcpSourceInWorkspace({
        client,
        workspaceId: installation.workspaceId,
        endpoint: demoServer.endpoint,
        name: "Demo",
        namespace: "demo",
      });

      expect(seeded.action).toBe("noop");
      expect(seeded.sourceId).toBe(existing.id);

      const sources = yield* client.sources.list({
        path: {
          workspaceId: installation.workspaceId,
        },
      });

      expect(sources).toHaveLength(1);
      expect(sources[0]?.endpoint).toBe(demoServer.endpoint);
    }),
  15_000,
  );

  it.scoped("loads OpenAPI sources from control-plane state and calls them", () =>
    Effect.gen(function* () {
      const openApiServer = yield* Effect.acquireRelease(
        Effect.promise(() => startOpenApiDemoServer()),
        (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
      );

      const previousGithubToken = process.env.GITHUB_TOKEN;
      const previousAllowEnvSecrets = process.env.DANGEROUSLY_ALLOW_ENV_SECRETS;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.GITHUB_TOKEN = "ghp_test_executor";
          process.env.DANGEROUSLY_ALLOW_ENV_SECRETS = "true";
        }),
        () =>
          Effect.sync(() => {
            if (previousGithubToken === undefined) {
              delete process.env.GITHUB_TOKEN;
            } else {
              process.env.GITHUB_TOKEN = previousGithubToken;
            }

            if (previousAllowEnvSecrets === undefined) {
              delete process.env.DANGEROUSLY_ALLOW_ENV_SECRETS;
            } else {
              process.env.DANGEROUSLY_ALLOW_ENV_SECRETS = previousAllowEnvSecrets;
            }
          }),
      );

      const server = yield* createIsolatedLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      yield* seedGithubOpenApiSourceInWorkspace({
        client,
        workspaceId: installation.workspaceId,
        endpoint: openApiServer.baseUrl,
        specUrl: openApiServer.specUrl,
        name: "GitHub",
        namespace: "github",
      });

      const execution = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: 'return await tools.github.repos.getRepo({ owner: "vercel", repo: "ai" });',
        },
      });

      expect(execution.execution.status).toBe("completed");
      expect(execution.pendingInteraction).toBeNull();
      expect(execution.execution.resultJson).toContain("\"full_name\":\"vercel/ai\"");
      expect(openApiServer.seenAuthHeaders).toEqual(["Bearer ghp_test_executor"]);
    }),
  );

  it.scoped("adds an OAuth-protected MCP source via executor.sources.add and resumes after callback", () =>
    Effect.gen(function* () {
      const oauthServer = yield* Effect.acquireRelease(
        Effect.promise(() => startOAuthProtectedMcpServer()),
        (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
      );

      const server = yield* createIsolatedLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      const added = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: `return await tools.executor.sources.add({ endpoint: ${JSON.stringify(oauthServer.endpoint)}, name: "Axiom", namespace: "axiom" });`,
          interactionMode: "live",
        },
      });

      expect(added.execution.status).toBe("waiting_for_interaction");
      expect(added.pendingInteraction).not.toBeNull();
      if (added.pendingInteraction === null) {
        throw new Error("Expected pending OAuth interaction");
      }
      expect(added.pendingInteraction.kind).toBe("url");

      const authorizationUrl = extractUrlInteractionUrl(added.pendingInteraction.payloadJson);
      const callbackResponse = yield* Effect.promise(() =>
        fetch(authorizationUrl, {
          redirect: "follow",
        }),
      );
      assertTrue(callbackResponse.ok);
      const callbackText = yield* Effect.promise(() => callbackResponse.text());
      expect(callbackText).toContain("Source connected:");

      const connectedSource = yield* Effect.gen(function* () {
        while (true) {
          const sources = yield* client.sources.list({
            path: {
              workspaceId: installation.workspaceId,
            },
          });
          const source = sources.find((entry) => entry.namespace === "axiom");
          if (source?.status === "connected" && source.auth.kind === "mcp_oauth") {
            return source;
          }

          yield* Effect.sleep("100 millis");
        }
      });

      expect(connectedSource.name).toBe("Axiom");
      expect(connectedSource.status).toBe("connected");
      expect(connectedSource.auth.kind).toBe("mcp_oauth");

      const toolCall = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: "return await tools.axiom.whoami({});",
        },
      });

      expect(toolCall.execution.status).toBe("waiting_for_interaction");
      expect(toolCall.pendingInteraction).not.toBeNull();
      if (toolCall.pendingInteraction !== null) {
        expect(toolCall.pendingInteraction.kind).toBe("form");
        expect(toolCall.pendingInteraction.payloadJson).toContain("Allow whoami?");
      }

      const approvedToolCall = yield* client.executions.resume({
        path: {
          workspaceId: installation.workspaceId,
          executionId: toolCall.execution.id,
        },
        payload: {
          responseJson: JSON.stringify({
            action: "accept",
            content: {
              approve: true,
            },
          }),
        },
      });

      expect(approvedToolCall.execution.status).toBe("completed");
      expect(approvedToolCall.pendingInteraction).toBeNull();
      expect(approvedToolCall.execution.resultJson).toContain("oauth-demo");
    }),
    15_000,
  );

  it.scoped("gates mutating OpenAPI tools by default and allows them via workspace policy", () =>
    Effect.gen(function* () {
      const openApiServer = yield* Effect.acquireRelease(
        Effect.promise(() => startMutatingOpenApiDemoServer()),
        (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
      );
      const server = yield* createIsolatedLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });
      const bootstrapClient = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });

      const connected = yield* client.sources.connect({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          kind: "openapi",
          name: "DNS",
          namespace: "dns",
          endpoint: openApiServer.baseUrl,
          specUrl: openApiServer.specUrl,
          auth: {
            kind: "none",
          },
        },
      });
      expect(connected.kind).toBe("connected");

      const gated = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: 'return await tools.dns.records.createRecord({ body: { type: "TXT", name: "", value: "hello world" } });',
        },
      });

      expect(gated.execution.status).toBe("waiting_for_interaction");
      expect(gated.pendingInteraction).not.toBeNull();
      if (gated.pendingInteraction === null) {
        throw new Error("Expected pending approval interaction");
      }
      expect(gated.pendingInteraction.kind).toBe("form");
      expect(gated.pendingInteraction.payloadJson).toContain("Allow Create a DNS record?");
      expect(gated.pendingInteraction.payloadJson).toContain("\"approve\"");

      const approved = yield* client.executions.resume({
        path: {
          workspaceId: installation.workspaceId,
          executionId: gated.execution.id,
        },
        payload: {
          responseJson: JSON.stringify({
            action: "accept",
            content: {
              approve: true,
            },
          }),
        },
      });

      expect(approved.execution.status).toBe("completed");
      expect(openApiServer.createdBodies).toHaveLength(1);

      const policy = yield* client.policies.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          resourcePattern: "dns.records.createRecord",
          effect: "allow",
          approvalMode: "auto",
        },
      });
      expect(policy.key).toBe("dns.records.createRecord");

      const automatic = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: 'return await tools.dns.records.createRecord({ body: { type: "TXT", name: "", value: "hello again" } });',
        },
      });

      expect(automatic.execution.status).toBe("completed");
      expect(automatic.pendingInteraction).toBeNull();
      expect(openApiServer.createdBodies).toHaveLength(2);
    }),
    15_000,
  );

  it.scoped("starts source OAuth without creating a source and stores secrets on callback", () =>
    Effect.gen(function* () {
      const oauthServer = yield* Effect.acquireRelease(
        Effect.promise(() => startOAuthProtectedMcpServer()),
        (server) => Effect.promise(() => server.close()).pipe(Effect.orDie),
      );

      const server = yield* createIsolatedLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});

      const startResponse = yield* Effect.promise(() =>
        fetch(`${server.baseUrl}/v1/workspaces/${encodeURIComponent(installation.workspaceId)}/oauth/source-auth/start`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-executor-account-id": installation.accountId,
          },
          body: JSON.stringify({
            provider: "mcp",
            endpoint: oauthServer.endpoint,
            transport: "auto",
          }),
        }),
      );

      assertTrue(startResponse.ok);
      const started: {
        sessionId: string;
        authorizationUrl: string;
      } = yield* Effect.promise(() => startResponse.json() as Promise<{
        sessionId: string;
        authorizationUrl: string;
      }>);

      expect(started.sessionId).toBeTruthy();
      expect(started.authorizationUrl).toBeDefined();

      const callbackResponse = yield* Effect.promise(() =>
        fetch(started.authorizationUrl, {
          redirect: "follow",
        }),
      );

      assertTrue(callbackResponse.ok);
      const callbackHtml = yield* Effect.promise(() => callbackResponse.text());
      expect(callbackHtml).toContain("OAuth connected");
      expect(callbackHtml).toContain("executor:oauth-result");

      const client = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });
      const sources = yield* client.sources.list({
        path: {
          workspaceId: installation.workspaceId,
        },
      });

      expect(sources).toHaveLength(0);

      const secrets = yield* bootstrapClient.local.listSecrets({});
      expect(secrets.some((secret) => secret.purpose === "oauth_access_token")).toBe(true);
      expect(secrets.some((secret) => secret.purpose === "oauth_refresh_token")).toBe(true);
    }),
    15_000,
  );

  it.scoped("marks execution failed when a configured MCP endpoint is invalid", () =>
    Effect.gen(function* () {
      const server = yield* createIsolatedLocalExecutorServer({
        port: 0,
        localDataDir: ":memory:",
      });

      const bootstrapClient = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
      });
      const installation = yield* bootstrapClient.local.installation({});
      const client = yield* createControlPlaneClient({
        baseUrl: server.baseUrl,
        accountId: installation.accountId,
      });
      yield* writeConfiguredLocalMcpSource({
        workspaceRoot: server.workspaceRoot,
        sourceId: "demo",
        endpoint: "http://127.0.0.1:PORT/mcp",
        name: "Demo",
        namespace: "demo",
      });

      const execution = yield* client.executions.create({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          code: 'return await tools.demo.gated_echo({ value: "broken" });',
        },
      });

      expect(execution.execution.status).toBe("waiting_for_interaction");
      expect(execution.pendingInteraction).not.toBeNull();
      if (execution.pendingInteraction !== null) {
        expect(execution.pendingInteraction.kind).toBe("form");
        expect(execution.pendingInteraction.payloadJson).toContain("Allow gated_echo?");
      }

      const resumed = yield* client.executions.resume({
        path: {
          workspaceId: installation.workspaceId,
          executionId: execution.execution.id,
        },
        payload: {
          responseJson: JSON.stringify({
            action: "accept",
            content: {
              approve: true,
            },
          }),
        },
      });

      expect(resumed.execution.status).toBe("failed");
      expect(resumed.pendingInteraction).toBeNull();
      expect(resumed.execution.errorText).toContain("Invalid URL");
    }),
  );
});
