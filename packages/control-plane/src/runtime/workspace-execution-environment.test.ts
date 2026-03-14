import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

import {
  FileSystem,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpServer,
} from "@effect/platform";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  buildOpenApiToolPresentation,
  compileOpenApiToolDefinitions,
  extractOpenApiManifest,
} from "@executor/codemode-openapi";
import { describe, expect, it } from "@effect/vitest";
import {
  graphql,
  GraphQLBoolean,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from "graphql";
import {
  AccountIdSchema,
  ExecutionIdSchema,
  SecretMaterialIdSchema,
  SourceIdSchema,
  SourceRecipeSchemaBundleIdSchema,
  WorkspaceIdSchema,
  type Source,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { Schema } from "effect";
import * as z from "zod/v4";

import {
  createSqlControlPlanePersistence,
  type SqlControlPlanePersistence,
} from "#persistence";
import type { SourceId, WorkspaceId } from "#schema";

import {
  createRuntimeSourceAuthService,
  type RuntimeSourceAuthService,
} from "./source-auth-service";
import {
  loadLocalExecutorConfig,
  resolveLocalWorkspaceContext,
  writeProjectLocalExecutorConfig,
} from "./local-config";
import { createLiveExecutionManager } from "./live-execution";
import {
  RuntimeLocalWorkspaceService,
  type RuntimeLocalWorkspaceState,
} from "./local-runtime-context";
import {
  buildLocalSourceArtifact,
  readLocalSourceArtifact,
  writeLocalSourceArtifact,
} from "./local-source-artifacts";
import {
  loadLocalWorkspaceState,
  writeLocalWorkspaceState,
} from "./local-workspace-state";
import { materializationFromMcpManifestEntries } from "./source-adapters/mcp";
import { createWorkspaceExecutionEnvironmentResolver } from "./workspace-execution-environment";

type CountedMcpServer = {
  endpoint: string;
  counts: {
    listTools: number;
    callTool: number;
  };
  close: () => Promise<void>;
};

type OpenApiSpecServer = {
  baseUrl: string;
  specUrl: string;
  seenAuthHeaders: Array<string | null>;
  close: () => Promise<void>;
};

type GraphqlServer = {
  endpoint: string;
  seenAuthHeaders: Array<string | null>;
  close: () => Promise<void>;
};

const normalizeSearchText = (
  ...parts: ReadonlyArray<string | null | undefined>
): string =>
  parts
    .flatMap((part) => (part ? [part.trim()] : []))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const provideNodeFileSystem = <A, E, R>(
  effect: Effect.Effect<A, E, R | FileSystem.FileSystem>,
): Effect.Effect<A, E, Exclude<R, FileSystem.FileSystem>> =>
  effect.pipe(Effect.provide(NodeFileSystem.layer)) as Effect.Effect<
    A,
    E,
    Exclude<R, FileSystem.FileSystem>
  >;

const GraphqlUserType = new GraphQLObjectType({
  name: "User",
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLID),
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
    },
  },
});

const GraphqlTeamType = new GraphQLObjectType({
  name: "Team",
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLID),
    },
    key: {
      type: new GraphQLNonNull(GraphQLString),
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
    },
  },
});

const GraphqlIssueType = new GraphQLObjectType({
  name: "Issue",
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLID),
    },
    identifier: {
      type: new GraphQLNonNull(GraphQLString),
    },
    title: {
      type: new GraphQLNonNull(GraphQLString),
    },
    team: {
      type: new GraphQLNonNull(GraphqlTeamType),
    },
  },
});

const GraphqlPageInfoType = new GraphQLObjectType({
  name: "PageInfo",
  fields: {
    hasNextPage: {
      type: new GraphQLNonNull(GraphQLBoolean),
    },
    endCursor: {
      type: GraphQLString,
    },
  },
});

const GraphqlIssueConnectionType = new GraphQLObjectType({
  name: "IssueConnection",
  fields: {
    nodes: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(GraphqlIssueType)),
      ),
    },
    pageInfo: {
      type: new GraphQLNonNull(GraphqlPageInfoType),
    },
  },
});

const GraphqlCreateIssueInputType = new GraphQLInputObjectType({
  name: "CreateIssueInput",
  fields: {
    title: {
      type: new GraphQLNonNull(GraphQLString),
    },
    teamId: {
      type: GraphQLID,
    },
  },
});

const GraphqlQueryType = new GraphQLObjectType({
  name: "Query",
  fields: {
    viewer: {
      type: new GraphQLNonNull(GraphqlUserType),
      description: "The current user",
      resolve: () => ({
        id: "usr_123",
        name: "Rhys",
      }),
    },
    issue: {
      type: GraphqlIssueType,
      description: "Find a single issue by id",
      args: {
        id: {
          type: new GraphQLNonNull(GraphQLID),
        },
      },
      resolve: (_source, args: { id: string }) => ({
        id: args.id,
        identifier: "ENG-123",
        title: "Investigate GraphQL support",
        team: {
          id: "team_eng",
          key: "ENG",
          name: "Engineering",
        },
      }),
    },
    issues: {
      type: new GraphQLNonNull(GraphqlIssueConnectionType),
      description: "List issues for the workspace",
      args: {
        first: {
          type: GraphQLInt,
        },
        query: {
          type: GraphQLString,
        },
      },
      resolve: () => ({
        nodes: [
          {
            id: "iss_1",
            identifier: "ENG-123",
            title: "Investigate GraphQL support",
            team: {
              id: "team_eng",
              key: "ENG",
              name: "Engineering",
            },
          },
          {
            id: "iss_2",
            identifier: "ENG-124",
            title: "Ship GraphQL field tools",
            team: {
              id: "team_eng",
              key: "ENG",
              name: "Engineering",
            },
          },
        ],
        pageInfo: {
          hasNextPage: false,
          endCursor: "iss_2",
        },
      }),
    },
  },
});

const GraphqlMutationType = new GraphQLObjectType({
  name: "Mutation",
  fields: {
    noop: {
      type: GraphQLString,
      resolve: () => "ok",
    },
    createIssue: {
      type: new GraphQLNonNull(GraphqlIssueType),
      description: "Create a new issue",
      args: {
        input: {
          type: new GraphQLNonNull(GraphqlCreateIssueInputType),
        },
      },
      resolve: (
        _source,
        args: { input: { title: string; teamId?: string | null } },
      ) => ({
        id: "iss_created",
        identifier: "ENG-999",
        title: args.input.title,
        team: {
          id: args.input.teamId ?? "team_eng",
          key: "ENG",
          name: "Engineering",
        },
      }),
    },
  },
});

const testGraphqlSchema = new GraphQLSchema({
  query: GraphqlQueryType,
  mutation: GraphqlMutationType,
});

const closeScope = (scope: Scope.CloseableScope) =>
  Scope.close(scope, Exit.void).pipe(Effect.orDie);

const makePersistence: Effect.Effect<
  SqlControlPlanePersistence,
  unknown,
  Scope.Scope
> = Effect.acquireRelease(
  createSqlControlPlanePersistence({
    localDataDir: ":memory:",
  }),
  (persistence) =>
    Effect.tryPromise({
      try: () => persistence.close(),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }).pipe(Effect.orDie),
);

const makeCountedMcpServer = Effect.acquireRelease(
  Effect.promise<CountedMcpServer>(
    () =>
      new Promise<CountedMcpServer>((resolve, reject) => {
        const counts = {
          listTools: 0,
          callTool: 0,
        };
        let closed = false;
        const app = createMcpExpressApp({ host: "127.0.0.1" });

        const createServer = () => {
          const server = new McpServer(
            {
              name: "workspace-execution-environment-test-server",
              version: "1.0.0",
            },
            {
              capabilities: {
                tools: {},
              },
            },
          );

          server.registerTool(
            "echo",
            {
              description: "Echo the provided string",
              inputSchema: {
                value: z.string(),
              },
            },
            async ({ value }: { value: string }) => ({
              content: [{ type: "text", text: `echo:${value}` }],
            }),
          );

          return server;
        };

        const countMethods = (body: unknown) => {
          const payloads = Array.isArray(body) ? body : [body];
          for (const payload of payloads) {
            if (!payload || typeof payload !== "object") {
              continue;
            }

            const method = "method" in payload ? payload.method : undefined;
            if (method === "tools/list") {
              counts.listTools += 1;
            } else if (method === "tools/call") {
              counts.callTool += 1;
            }
          }
        };

        const handle = async (req: any, res: any, parsedBody?: unknown) => {
          countMethods(parsedBody);

          const server = createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });

          try {
            await server.connect(transport);
            await transport.handleRequest(req, res, parsedBody);
          } finally {
            await transport.close().catch(() => undefined);
            await server.close().catch(() => undefined);
          }
        };

        app.post("/mcp", async (req: any, res: any) => {
          await handle(req, res, req.body);
        });

        app.get("/mcp", async (req: any, res: any) => {
          await handle(req, res);
        });

        app.delete("/mcp", async (req: any, res: any) => {
          await handle(req, res, req.body);
        });

        const listener = app.listen(0, "127.0.0.1", () => {
          const address = listener.address();
          if (!address || typeof address === "string") {
            reject(new Error("failed to resolve MCP test server address"));
            return;
          }

          resolve({
            endpoint: `http://127.0.0.1:${address.port}/mcp`,
            counts,
            close: async () => {
              if (closed) {
                return;
              }
              closed = true;

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

const ownerParam = HttpApiSchema.param("owner", Schema.String);
const repoParam = HttpApiSchema.param("repo", Schema.String);

class GeneratedReposApi extends HttpApiGroup.make("repos").add(
  HttpApiEndpoint.get("getRepo")`/repos/${ownerParam}/${repoParam}`.addSuccess(
    Schema.Struct({
      ok: Schema.Boolean,
      full_name: Schema.String,
    }),
  ),
) {}

class GeneratedApi extends HttpApi.make("generated").add(GeneratedReposApi) {}

const makeOpenApiSpecServer = Effect.acquireRelease(
  Effect.gen(function* () {
    const seenAuthHeaders: OpenApiSpecServer["seenAuthHeaders"] = [];
    const handlersLayer = HttpApiBuilder.group(
      GeneratedApi,
      "repos",
      (handlers) =>
        handlers.handle("getRepo", ({ path, request }) =>
          Effect.sync(() => {
            seenAuthHeaders.push(
              typeof request.headers.authorization === "string"
                ? request.headers.authorization
                : null,
            );

            return {
              ok: true,
              full_name: `${path.owner}/${path.repo}`,
            };
          }),
        ),
    );
    const apiLayer = HttpApiBuilder.api(GeneratedApi).pipe(
      Layer.provide(handlersLayer),
    );
    const serverLayer = HttpApiBuilder.serve().pipe(
      Layer.provide(HttpApiBuilder.middlewareOpenApi()),
      Layer.provide(apiLayer),
      Layer.provideMerge(NodeHttpServer.layerTest),
    );
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(serverLayer, scope).pipe(
      Effect.catchAll((error) =>
        closeScope(scope).pipe(Effect.zipRight(Effect.fail(error))),
      ),
    );
    const server = Context.get(context, HttpServer.HttpServer);
    const baseUrl = HttpServer.formatAddress(server.address);

    return {
      baseUrl,
      specUrl: new URL("/openapi.json", baseUrl).toString(),
      seenAuthHeaders,
      close: () => Effect.runPromise(closeScope(scope)),
    } satisfies OpenApiSpecServer;
  }),
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }).pipe(Effect.orDie),
);

const makeGraphqlServer = Effect.acquireRelease(
  Effect.promise<GraphqlServer>(
    () =>
      new Promise<GraphqlServer>((resolve, reject) => {
        const seenAuthHeaders: Array<string | null> = [];
        const server = createServer(async (request, response) => {
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end();
            return;
          }

          const chunks: Array<Buffer> = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }

          const rawBody = Buffer.concat(chunks).toString("utf8");
          const parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
          seenAuthHeaders.push(
            typeof request.headers.authorization === "string"
              ? request.headers.authorization
              : null,
          );
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");

          const result = await graphql({
            schema: testGraphqlSchema,
            source:
              typeof parsedBody.query === "string" ? parsedBody.query : "",
            variableValues:
              parsedBody.variables && typeof parsedBody.variables === "object"
                ? (parsedBody.variables as Record<string, unknown>)
                : undefined,
            operationName:
              typeof parsedBody.operationName === "string"
                ? parsedBody.operationName
                : undefined,
          });

          response.end(JSON.stringify(result));
        });

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Failed to resolve GraphQL test server address"));
            return;
          }

          resolve({
            endpoint: `http://127.0.0.1:${address.port}/graphql`,
            seenAuthHeaders,
            close: () =>
              new Promise<void>((closeResolve, closeReject) => {
                server.close((error) => {
                  if (error) {
                    closeReject(error);
                    return;
                  }

                  closeResolve();
                });
              }),
          });
        });
      }),
  ),
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }).pipe(Effect.orDie),
);

const persistConnectedEchoTool = (input: {
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  endpoint: string;
  workspaceId: WorkspaceId;
  sourceId: SourceId;
}): Effect.Effect<void, unknown, never> =>
  Effect.gen(function* () {
    const now = Date.now();
    const source: Source = {
      id: input.sourceId,
      workspaceId: input.workspaceId,
      name: "Counted MCP",
      kind: "mcp",
      endpoint: input.endpoint,
      status: "connected",
      enabled: true,
      namespace: "counted",
      bindingVersion: 1,
      binding: {
        transport: "streamable-http",
        queryParams: null,
        headers: null,
      },
      importAuthPolicy: "reuse_runtime",
      importAuth: { kind: "none" },
      auth: { kind: "none" },
      sourceHash: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    yield* writeProjectLocalExecutorConfig({
      context: input.runtimeLocalWorkspace.context,
      config: {
        sources: {
          [input.sourceId]: {
            kind: "mcp",
            name: source.name,
            ...(source.namespace ? { namespace: source.namespace } : {}),
            connection: {
              endpoint: source.endpoint,
            },
            binding: {
              transport: "streamable-http",
            },
          },
        },
      },
    });
    yield* writeLocalSourceArtifact({
      context: input.runtimeLocalWorkspace.context,
      sourceId: source.id,
      artifact: buildLocalSourceArtifact({
        source,
        materialization: materializationFromMcpManifestEntries({
          recipeRevisionId: "src_recipe_rev_materialization" as never,
          endpoint: source.endpoint,
          manifestEntries: [
            {
              toolId: "echo",
              toolName: "echo",
              description: "Echo the provided string",
              inputSchemaJson: JSON.stringify({
                type: "object",
                properties: {
                  value: { type: "string" },
                },
                required: ["value"],
                additionalProperties: false,
              }),
            },
          ],
        }),
      }),
    });
    yield* writeLocalWorkspaceState({
      context: input.runtimeLocalWorkspace.context,
      state: {
        version: 1,
        sources: {
          [input.sourceId]: {
            status: "connected",
            lastError: null,
            sourceHash: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        policies: {},
      },
    });
  }) as Effect.Effect<void, Error, never>;

const persistConnectedGithubOpenApiSource = (input: {
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  endpoint?: string;
  auth?: {
    providerId: string;
    handle: string;
  } | null;
}): Effect.Effect<void, unknown, never> =>
  Effect.gen(function* () {
    const now = Date.now();
    const openApiDocumentText = JSON.stringify({
      openapi: "3.0.3",
      info: {
        title: "GitHub",
        version: "1.0.0",
      },
      paths: {
        "/repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}":
          {
            get: {
              operationId: "actions/get-environment-secret",
              tags: ["actions"],
              summary: "Get an environment secret",
              description:
                "Gets a single environment secret without revealing its encrypted value. Authenticated users must have collaborator access to a repository to create, update, or read secrets.",
              parameters: [
                {
                  name: "owner",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
                {
                  name: "repo",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
                {
                  name: "environment_name",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
                {
                  name: "secret_name",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: {
                200: {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Repository" },
                    },
                  },
                },
              },
            },
          },
        "/orgs/{org}/actions/runners/{runner_id}": {
          get: {
            operationId: "actions/get-self-hosted-runner-for-org",
            tags: ["actions"],
            summary: "Get a self-hosted runner for an organization",
            description:
              "Gets a specific self-hosted runner configured in an organization. Authenticated users must have admin access to the organization to use this endpoint.",
            parameters: [
              {
                name: "org",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "runner_id",
                in: "path",
                required: true,
                schema: { type: "integer" },
              },
            ],
            responses: {
              200: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
        "/repos/{owner}/{repo}": {
          get: {
            operationId: "repos/get-repo",
            tags: ["repos"],
            summary: "Get a repository",
            description: "Gets a repository by owner and name.",
            parameters: [
              {
                name: "owner",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "repo",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              200: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
        "/user": {
          get: {
            operationId: "users/get-authenticated",
            tags: ["users"],
            summary: "Get the authenticated user",
            description:
              "Gets the authenticated user. OAuth app tokens and personal access tokens need the user scope to include private profile information.",
            responses: {
              200: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Repository: {
            type: "object",
            properties: {
              full_name: { type: "string" },
              private: { type: "boolean" },
            },
            required: ["full_name"],
          },
        },
      },
    });

    const source: Source = {
      id: input.sourceId,
      workspaceId: input.workspaceId,
      name: "GitHub",
      kind: "openapi",
      endpoint: input.endpoint ?? "https://api.github.com",
      status: "connected",
      enabled: true,
      namespace: "github",
      bindingVersion: 1,
      binding: {
        specUrl: "https://example.com/github-openapi.json",
        defaultHeaders: null,
      },
      importAuthPolicy: "reuse_runtime",
      importAuth: { kind: "none" },
      auth: input.auth
        ? {
            kind: "bearer",
            headerName: "Authorization",
            prefix: "Bearer ",
            token: {
              providerId: input.auth.providerId,
              handle: input.auth.handle,
            },
          }
        : { kind: "none" },
      sourceHash: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    const configAuth =
      source.auth.kind === "bearer"
        ? source.auth.token.providerId === "params"
          ? {
              source: "params" as const,
              provider: "params",
              id: source.auth.token.handle,
            }
          : source.auth.token.providerId === "env"
            ? source.auth.token.handle
            : {
                source: "env" as const,
                provider: "env",
                id: source.auth.token.handle,
              }
        : undefined;

    const manifest = yield* extractOpenApiManifest(
      source.name,
      openApiDocumentText,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
    const definitions = compileOpenApiToolDefinitions(manifest);
    yield* writeProjectLocalExecutorConfig({
      context: input.runtimeLocalWorkspace.context,
      config: {
        sources: {
          [input.sourceId]: {
            kind: "openapi",
            name: source.name,
            ...(source.namespace ? { namespace: source.namespace } : {}),
            connection: {
              endpoint: source.endpoint,
              ...(configAuth !== undefined ? { auth: configAuth } : {}),
            },
            binding: {
              specUrl: String(source.binding.specUrl),
              defaultHeaders: null,
            },
          },
        },
      },
    });
    const refEntries = Object.entries(manifest.refHintTable ?? {});
    yield* writeLocalSourceArtifact({
      context: input.runtimeLocalWorkspace.context,
      sourceId: source.id,
      artifact: buildLocalSourceArtifact({
        source: {
          ...source,
          sourceHash: manifest.sourceHash,
        },
        materialization: {
          manifestJson: JSON.stringify(manifest),
          manifestHash: manifest.sourceHash,
          sourceHash: manifest.sourceHash,
          documents: [
            {
              id: `src_recipe_doc_${randomUUID()}`,
              recipeRevisionId: "src_recipe_rev_materialization" as never,
              documentKind: "openapi",
              documentKey:
                typeof source.binding.specUrl === "string"
                  ? source.binding.specUrl
                  : source.endpoint,
              contentText: openApiDocumentText,
              contentHash: manifest.sourceHash,
              fetchedAt: now,
              createdAt: now,
              updatedAt: now,
            },
          ],
          schemaBundles:
            refEntries.length > 0
              ? [
                  {
                    id: SourceRecipeSchemaBundleIdSchema.make(
                      `src_recipe_bundle_${randomUUID()}`,
                    ),
                    recipeRevisionId: "src_recipe_rev_materialization" as never,
                    bundleKind: "json_schema_ref_map",
                    refsJson: JSON.stringify(
                      Object.fromEntries(
                        refEntries.map(([ref, rawValue]) => {
                          try {
                            return [ref, JSON.parse(rawValue) as unknown];
                          } catch {
                            return [ref, rawValue];
                          }
                        }),
                      ),
                    ),
                    contentHash: manifest.sourceHash,
                    createdAt: now,
                    updatedAt: now,
                  },
                ]
              : [],
          operations: definitions.map((definition) => {
            const presentation = buildOpenApiToolPresentation({
              definition,
            });
            const method = definition.method.toUpperCase();

            return {
              id: `src_recipe_op_${randomUUID()}`,
              recipeRevisionId: "src_recipe_rev_materialization" as never,
              operationKey: definition.toolId,
              transportKind: "http",
              toolId: definition.toolId,
              title: definition.name,
              description: definition.description,
              operationKind:
                method === "GET" || method === "HEAD"
                  ? "read"
                  : method === "DELETE"
                    ? "delete"
                    : "write",
              searchText: normalizeSearchText(
                definition.toolId,
                definition.name,
                definition.description,
                definition.rawToolId,
                definition.operationId ?? undefined,
                definition.method,
                definition.path,
                definition.group,
                definition.leaf,
                definition.tags.join(" "),
              ),
              inputSchemaJson: presentation.inputSchemaJson ?? null,
              outputSchemaJson: presentation.outputSchemaJson ?? null,
              providerKind: "openapi",
              providerDataJson: presentation.providerDataJson,
              createdAt: now,
              updatedAt: now,
            };
          }),
        },
      }),
    });
    yield* writeLocalWorkspaceState({
      context: input.runtimeLocalWorkspace.context,
      state: {
        version: 1,
        sources: {
          [input.sourceId]: {
            status: "connected",
            lastError: null,
            sourceHash: manifest.sourceHash,
            createdAt: now,
            updatedAt: now,
          },
        },
        policies: {},
      },
    });

    return;
  }) as Effect.Effect<void, Error, never>;

const makeRuntimeLocalWorkspaceState = (
  workspaceId: WorkspaceId,
): Effect.Effect<RuntimeLocalWorkspaceState, Error, Scope.Scope> =>
  provideNodeFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "executor-workspace-env-",
      });
      const context = yield* resolveLocalWorkspaceContext({ workspaceRoot });
      const loadedConfig = yield* loadLocalExecutorConfig(context);
      return {
        context,
        installation: {
          workspaceId,
          accountId: AccountIdSchema.make("acc_local_test"),
        },
        loadedConfig,
      } satisfies RuntimeLocalWorkspaceState;
    }),
  );

const writeLocalToolSource = (input: {
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState;
  relativePath: string;
  content: string;
}): Effect.Effect<void, Error, never> =>
  provideNodeFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const toolPath = join(
        input.runtimeLocalWorkspace.context.configDirectory,
        "tools",
        input.relativePath,
      );
      yield* fs.makeDirectory(dirname(toolPath), { recursive: true });
      yield* fs.writeFileString(toolPath, input.content);
    }),
  );

const makeResolver =
  (
    persistence: SqlControlPlanePersistence,
    runtimeLocalWorkspace: RuntimeLocalWorkspaceState,
  ) =>
  (
    input: Parameters<
      ReturnType<typeof createWorkspaceExecutionEnvironmentResolver>
    >[0],
  ) =>
    createWorkspaceExecutionEnvironmentResolver({
      rows: persistence.rows,
      sourceAuthService: {
        getLocalServerBaseUrl: () => null,
        storeSecretMaterial: () =>
          Effect.fail(new Error("not implemented in test")),
        getSourceById: () => Effect.fail(new Error("not implemented in test")),
        addExecutorSource: () =>
          Effect.fail(new Error("not implemented in test")),
        connectMcpSource: () =>
          Effect.fail(new Error("not implemented in test")),
        startSourceOAuthSession: () =>
          Effect.fail(new Error("not implemented in test")),
        completeSourceOAuthSession: () =>
          Effect.fail(new Error("not implemented in test")),
        completeSourceCredentialSetup: () =>
          Effect.fail(new Error("not implemented in test")),
      } as RuntimeSourceAuthService,
    })(input).pipe(
      Effect.provideService(
        RuntimeLocalWorkspaceService,
        runtimeLocalWorkspace,
      ),
    );

const makeResolverWithLiveSourceAuth =
  (
    persistence: SqlControlPlanePersistence,
    runtimeLocalWorkspace: RuntimeLocalWorkspaceState,
  ) =>
  (
    input: Parameters<
      ReturnType<typeof createWorkspaceExecutionEnvironmentResolver>
    >[0],
  ) =>
    createWorkspaceExecutionEnvironmentResolver({
      rows: persistence.rows,
      sourceAuthService: createRuntimeSourceAuthService({
        rows: persistence.rows,
        liveExecutionManager: createLiveExecutionManager(),
        getLocalServerBaseUrl: () => "http://127.0.0.1:8788",
      }),
    })(input).pipe(
      Effect.provideService(
        RuntimeLocalWorkspaceService,
        runtimeLocalWorkspace,
      ),
    );

describe("workspace-execution-environment", () => {
  it.scoped("discovers persisted tools without live MCP listing", () =>
    Effect.gen(function* () {
      const server = yield* makeCountedMcpServer;
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_catalog");
      const sourceId = SourceIdSchema.make("src_catalog");
      const runtimeLocalWorkspace =
        yield* makeRuntimeLocalWorkspaceState(workspaceId);
      yield* persistConnectedEchoTool({
        runtimeLocalWorkspace,
        endpoint: server.endpoint,
        workspaceId,
        sourceId,
      });

      yield* Effect.tryPromise({
        try: () => server.close(),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }).pipe(Effect.orDie);

      const resolveEnvironment = makeResolver(
        persistence,
        runtimeLocalWorkspace,
      );
      const environment = yield* resolveEnvironment({
        workspaceId,
        accountId: AccountIdSchema.make("acc_catalog"),
        executionId: ExecutionIdSchema.make("exec_catalog"),
      });

      const discovered = (yield* environment.toolInvoker.invoke({
        path: "discover",
        args: {
          query: "echo string",
          limit: 5,
        },
      })) as {
        bestPath: string | null;
        total: number;
        results: Array<{ path: string }>;
      };

      expect(discovered.bestPath).toBe("counted.echo");
      expect(discovered.total).toBeGreaterThan(0);
      expect(server.counts.listTools).toBe(0);
      expect(server.counts.callTool).toBe(0);
    }),
  );

  it.scoped(
    "prefers namespace and path matches over noisy GitHub boilerplate",
    () =>
      Effect.gen(function* () {
        const persistence = yield* makePersistence;
        const workspaceId = WorkspaceIdSchema.make("ws_github_discovery");
        const sourceId = SourceIdSchema.make("src_github_discovery");
        const runtimeLocalWorkspace =
          yield* makeRuntimeLocalWorkspaceState(workspaceId);
        yield* persistConnectedGithubOpenApiSource({
          runtimeLocalWorkspace,
          workspaceId,
          sourceId,
        });

        const resolveEnvironment = makeResolver(
          persistence,
          runtimeLocalWorkspace,
        );
        const environment = yield* resolveEnvironment({
          workspaceId,
          accountId: AccountIdSchema.make("acc_github_discovery"),
          executionId: ExecutionIdSchema.make("exec_github_discovery"),
        });

        const firstQuery = (yield* environment.toolInvoker.invoke({
          path: "discover",
          args: {
            query: "current authenticated user profile",
            limit: 5,
          },
        })) as {
          bestPath: string | null;
          results: Array<{ path: string }>;
        };

        expect(firstQuery.bestPath).toBe("github.users.getAuthenticated");
        expect(firstQuery.results[0]?.path).toBe(
          "github.users.getAuthenticated",
        );

        const secondQuery = (yield* environment.toolInvoker.invoke({
          path: "discover",
          args: {
            query: "users get myself current user profile",
            limit: 5,
          },
        })) as {
          bestPath: string | null;
          results: Array<{ path: string }>;
        };

        expect(secondQuery.bestPath).toBe("github.users.getAuthenticated");
        expect(secondQuery.results[0]?.path).toBe(
          "github.users.getAuthenticated",
        );
      }),
  );

  it.scoped("invokes persisted MCP tools on demand without re-listing", () =>
    Effect.gen(function* () {
      const server = yield* makeCountedMcpServer;
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_invoke");
      const sourceId = SourceIdSchema.make("src_invoke");
      const runtimeLocalWorkspace =
        yield* makeRuntimeLocalWorkspaceState(workspaceId);
      yield* persistConnectedEchoTool({
        runtimeLocalWorkspace,
        endpoint: server.endpoint,
        workspaceId,
        sourceId,
      });

      const resolveEnvironment = makeResolver(
        persistence,
        runtimeLocalWorkspace,
      );
      const environment = yield* resolveEnvironment({
        workspaceId,
        accountId: AccountIdSchema.make("acc_invoke"),
        executionId: ExecutionIdSchema.make("exec_invoke"),
      });

      const result = (yield* environment.toolInvoker.invoke({
        path: "counted.echo",
        args: {
          value: "hello",
        },
      })) as {
        content?: Array<{ text?: string }>;
      };

      expect(server.counts.listTools).toBe(0);
      expect(server.counts.callTool).toBe(1);
      expect(result.content?.[0]?.text).toBe("echo:hello");
    }),
  );

  it.scoped(
    "discovers and invokes local TypeScript tools from grouped directories",
    () =>
      Effect.gen(function* () {
        const persistence = yield* makePersistence;
        const workspaceId = WorkspaceIdSchema.make("ws_local_tools");
        const runtimeLocalWorkspace =
          yield* makeRuntimeLocalWorkspaceState(workspaceId);
        yield* writeLocalToolSource({
          runtimeLocalWorkspace,
          relativePath: join("math", "arithmetic", "add.ts"),
          content: `
import { Schema } from "effect"

const inputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    a: Schema.Number,
    b: Schema.Number,
  }),
)

const outputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    sum: Schema.Number,
  }),
)

export default {
  description: "Add two numbers together",
  inputSchema,
  outputSchema,
  async execute({ a, b }: { a: number; b: number }) {
    await Promise.resolve()
    return { sum: a + b }
  },
}
`.trimStart(),
        });
        yield* writeLocalToolSource({
          runtimeLocalWorkspace,
          relativePath: join("text", "case", "upper.ts"),
          content: `
import { defineLocalTool } from "@executor/control-plane"
import * as z from "zod/v4"

const inputSchema = z.object({
  value: z.string(),
})

const outputSchema = z.object({
  value: z.string(),
})

export const tool = defineLocalTool({
  description: "Convert text to uppercase",
  inputSchema,
  outputSchema,
  async execute({ value }) {
    await Promise.resolve()
    return { value: value.toUpperCase() }
  },
})
`.trimStart(),
        });

        const resolveEnvironment = makeResolver(
          persistence,
          runtimeLocalWorkspace,
        );
        const environment = yield* resolveEnvironment({
          workspaceId,
          accountId: AccountIdSchema.make("acc_local_tools"),
          executionId: ExecutionIdSchema.make("exec_local_tools"),
        });

        const discovered = (yield* environment.toolInvoker.invoke({
          path: "discover",
          args: {
            query: "add two numbers arithmetic",
            limit: 5,
          },
        })) as {
          bestPath: string | null;
          results: Array<{ path: string }>;
        };

        expect(discovered.bestPath).toBe("math.arithmetic.add");
        expect(discovered.results[0]?.path).toBe("math.arithmetic.add");

        const listed = yield* environment.catalog!.listTools({
          namespace: "math.arithmetic",
          limit: 5,
          includeSchemas: false,
        });

        expect(listed).toHaveLength(1);
        expect(listed[0]?.path).toBe("math.arithmetic.add");
        expect(listed[0]?.sourceKey).toBe("local.tool.math.arithmetic.add");

        const result = (yield* environment.toolInvoker.invoke({
          path: "math.arithmetic.add",
          args: {
            a: 2,
            b: 3,
          },
        })) as { sum: number };

        expect(result.sum).toBe(5);

        const upper = (yield* environment.toolInvoker.invoke({
          path: "text.case.upper",
          args: {
            value: "hello",
          },
        })) as { value: string };

        expect(upper.value).toBe("HELLO");
      }),
  );

  it.scoped(
    "adds an OpenAPI source through executor.sources.add with elicited credentials",
    () =>
      Effect.gen(function* () {
        const specServer = yield* makeOpenApiSpecServer;
        const persistence = yield* makePersistence;
        const workspaceId = WorkspaceIdSchema.make("ws_add_openapi");
        const runtimeLocalWorkspace =
          yield* makeRuntimeLocalWorkspaceState(workspaceId);
        const resolveEnvironment = makeResolverWithLiveSourceAuth(
          persistence,
          runtimeLocalWorkspace,
        );
        const now = Date.now();
        const tokenSecretMaterialId = SecretMaterialIdSchema.make(
          "sec_test_openapi_bearer",
        );
        yield* persistence.rows.secretMaterials.upsert({
          id: tokenSecretMaterialId,
          name: null,
          purpose: "auth_material",
          value: "ghp_test_token",
          createdAt: now,
          updatedAt: now,
        });
        let capturedElicitation: {
          mode?: string;
          url?: string;
          elicitationId?: string;
        } | null = null;

        const environment = yield* resolveEnvironment({
          workspaceId,
          accountId: AccountIdSchema.make("acc_add_openapi"),
          executionId: ExecutionIdSchema.make("exec_add_openapi"),
          onElicitation: (request) =>
            Effect.sync(() => {
              capturedElicitation = request.elicitation as {
                mode?: string;
                url?: string;
                elicitationId?: string;
              };

              return {
                action: "accept" as const,
                content: {
                  authKind: "bearer",
                  tokenRef: {
                    providerId: "postgres",
                    handle: tokenSecretMaterialId,
                  },
                },
              };
            }),
        });

        const added = (yield* environment.toolInvoker.invoke({
          path: "executor.sources.add",
          args: {
            kind: "openapi",
            endpoint: specServer.baseUrl,
            specUrl: specServer.specUrl,
            name: "GitHub",
            namespace: "github",
          },
          context: {
            runId: "exec_add_openapi",
          },
        })) as {
          id: SourceId;
          kind: string;
          status: string;
          auth: {
            kind: string;
            token?: {
              providerId: string;
            };
          };
        };

        expect(added.kind).toBe("openapi");
        expect(added.status).toBe("connected");
        expect(added.auth.kind).toBe("bearer");
        expect(added.auth.token?.providerId).toBe("postgres");
        expect(capturedElicitation).toMatchObject({
          mode: "url",
          url: expect.stringContaining("/v1/workspaces/"),
          elicitationId: expect.stringContaining("executor.sources.add:"),
        });
        expect((capturedElicitation as { url?: string } | null)?.url).toContain(
          encodeURIComponent("exec_add_openapi:executor.sources.add:"),
        );

        const loadedConfig = yield* loadLocalExecutorConfig(
          runtimeLocalWorkspace.context,
        );
        expect(loadedConfig.config?.sources?.[added.id]).toMatchObject({
          kind: "openapi",
          connection: {
            endpoint: `${specServer.baseUrl}/`,
          },
        });
        const artifact = yield* readLocalSourceArtifact({
          context: runtimeLocalWorkspace.context,
          sourceId: added.id,
        });
        expect(artifact?.documents[0]?.contentText).toContain(
          '"operationId":"repos.getRepo"',
        );
        const workspaceState = yield* loadLocalWorkspaceState(
          runtimeLocalWorkspace.context,
        );
        expect(workspaceState.sources[added.id]?.status).toBe("connected");

        const freshEnvironment = yield* resolveEnvironment({
          workspaceId,
          accountId: AccountIdSchema.make("acc_add_openapi"),
          executionId: ExecutionIdSchema.make("exec_add_openapi_fresh"),
        });

        const discovered = (yield* freshEnvironment.toolInvoker.invoke({
          path: "discover",
          args: {
            query: "github repo",
            limit: 5,
          },
        })) as {
          bestPath: string | null;
        };

        expect(discovered.bestPath).toBe("github.repos.getRepo");

        const invoked = (yield* freshEnvironment.toolInvoker.invoke({
          path: "github.repos.getRepo",
          args: {
            owner: "vercel",
            repo: "ai",
          },
        })) as {
          ok: boolean;
          full_name: string;
        };

        expect(invoked).toEqual({
          ok: true,
          full_name: "vercel/ai",
        });
        expect(specServer.seenAuthHeaders).toEqual(["Bearer ghp_test_token"]);
      }),
  );

  it.scoped(
    "adds a GraphQL source through executor.sources.add with elicited credentials",
    () =>
      Effect.gen(function* () {
        const graphqlServer = yield* makeGraphqlServer;
        const persistence = yield* makePersistence;
        const workspaceId = WorkspaceIdSchema.make("ws_add_graphql");
        const runtimeLocalWorkspace =
          yield* makeRuntimeLocalWorkspaceState(workspaceId);
        const resolveEnvironment = makeResolverWithLiveSourceAuth(
          persistence,
          runtimeLocalWorkspace,
        );
        const now = Date.now();
        const tokenSecretMaterialId = SecretMaterialIdSchema.make(
          "sec_test_graphql_bearer",
        );
        yield* persistence.rows.secretMaterials.upsert({
          id: tokenSecretMaterialId,
          name: null,
          purpose: "auth_material",
          value: "linear_test_token",
          createdAt: now,
          updatedAt: now,
        });

        const environment = yield* resolveEnvironment({
          workspaceId,
          accountId: AccountIdSchema.make("acc_add_graphql"),
          executionId: ExecutionIdSchema.make("exec_add_graphql"),
          onElicitation: () =>
            Effect.succeed({
              action: "accept" as const,
              content: {
                authKind: "bearer",
                tokenRef: {
                  providerId: "postgres",
                  handle: tokenSecretMaterialId,
                },
              },
            }),
        });

        const added = (yield* environment.toolInvoker.invoke({
          path: "executor.sources.add",
          args: {
            kind: "graphql",
            endpoint: graphqlServer.endpoint,
            name: "Linear",
            namespace: "linear",
          },
          context: {
            runId: "exec_add_graphql",
          },
        })) as {
          id: SourceId;
          kind: string;
          status: string;
          auth: {
            kind: string;
            token?: {
              providerId: string;
            };
          };
        };

        expect(added.kind).toBe("graphql");
        expect(added.status).toBe("connected");
        expect(added.auth.kind).toBe("bearer");
        expect(added.auth.token?.providerId).toBe("postgres");

        const artifact = yield* readLocalSourceArtifact({
          context: runtimeLocalWorkspace.context,
          sourceId: added.id,
        });
        expect(artifact?.documents[0]?.contentText).toContain('"__schema"');
        expect(artifact?.schemaBundles.length).toBe(1);
        if (artifact === null) {
          throw new Error(`Missing local source artifact for ${added.id}`);
        }

        yield* writeLocalSourceArtifact({
          context: runtimeLocalWorkspace.context,
          sourceId: added.id,
          artifact: {
            ...artifact,
            revision: {
              ...artifact.revision,
              manifestJson: null,
              updatedAt: Date.now(),
            },
          },
        });

        const freshEnvironment = yield* resolveEnvironment({
          workspaceId,
          accountId: AccountIdSchema.make("acc_add_graphql"),
          executionId: ExecutionIdSchema.make("exec_add_graphql_fresh"),
          onElicitation: () =>
            Effect.succeed({
              action: "accept" as const,
            }),
        });

        const discovered = (yield* freshEnvironment.toolInvoker.invoke({
          path: "discover",
          args: {
            query: "linear current user viewer",
            limit: 5,
          },
        })) as {
          bestPath: string | null;
        };

        expect(discovered.bestPath).toBe("linear.viewer");

        const describeCreateIssue = (yield* freshEnvironment.toolInvoker.invoke(
          {
            path: "describe.tool",
            args: {
              path: "linear.createIssue",
              includeSchemas: true,
            },
          },
        )) as {
          path: string;
          inputType?: string;
          inputSchemaJson?: string;
          schemaBundleId?: string;
        } | null;

        expect(describeCreateIssue?.path).toBe("linear.createIssue");
        expect(describeCreateIssue?.inputType).toContain("input");
        expect(describeCreateIssue?.inputType).toContain("CreateIssueInput");
        expect(describeCreateIssue?.inputSchemaJson).toContain("$ref");
        expect(describeCreateIssue?.schemaBundleId).toBeDefined();

        const graphqlSchemaBundle = (yield* freshEnvironment.toolInvoker.invoke(
          {
            path: "describe.schemaBundle",
            args: {
              id: describeCreateIssue?.schemaBundleId,
            },
          },
        )) as {
          kind: string;
          refsJson: string;
        } | null;

        expect(graphqlSchemaBundle?.kind).toBe("json_schema_ref_map");
        expect(graphqlSchemaBundle?.refsJson).toContain("CreateIssueInput");
        expect(graphqlSchemaBundle?.refsJson).toContain('"title"');

        const viewerResult = (yield* freshEnvironment.toolInvoker.invoke({
          path: "linear.viewer",
          args: {},
        })) as {
          data: {
            id: string;
            name: string;
            __typename: string;
          };
          errors: unknown[];
        };

        expect(viewerResult).toMatchObject({
          data: {
            id: "usr_123",
            name: "Rhys",
            __typename: "User",
          },
          errors: [],
        });

        const createIssueResult = (yield* freshEnvironment.toolInvoker.invoke({
          path: "linear.createIssue",
          args: {
            input: {
              title: "Ship GraphQL field tools",
            },
          },
        })) as {
          data: {
            id: string;
            identifier: string;
            title: string;
            __typename: string;
          };
          errors: unknown[];
        };

        expect(createIssueResult).toMatchObject({
          data: {
            id: "iss_created",
            identifier: "ENG-999",
            title: "Ship GraphQL field tools",
            __typename: "Issue",
          },
          errors: [],
        });

        const rawRequestResult = (yield* freshEnvironment.toolInvoker.invoke({
          path: "linear.request",
          args: {
            query: "query Viewer { viewer { id name } }",
          },
        })) as {
          status: number;
          body: {
            data: {
              viewer: {
                id: string;
                name: string;
              };
            };
          };
        };

        expect(rawRequestResult.status).toBe(200);
        expect(rawRequestResult.body).toEqual({
          data: {
            viewer: {
              id: "usr_123",
              name: "Rhys",
            },
          },
        });
        expect(graphqlServer.seenAuthHeaders).toEqual([
          "Bearer linear_test_token",
          "Bearer linear_test_token",
          "Bearer linear_test_token",
          "Bearer linear_test_token",
        ]);
      }),
  );

  it.scoped("resolves params-backed source auth from invocation context", () =>
    Effect.gen(function* () {
      const specServer = yield* makeOpenApiSpecServer;
      const persistence = yield* makePersistence;
      const workspaceId = WorkspaceIdSchema.make("ws_params_auth");
      const sourceId = SourceIdSchema.make("src_params_auth");
      const runtimeLocalWorkspace =
        yield* makeRuntimeLocalWorkspaceState(workspaceId);

      yield* persistConnectedGithubOpenApiSource({
        runtimeLocalWorkspace,
        workspaceId,
        sourceId,
        endpoint: specServer.baseUrl,
        auth: {
          providerId: "params",
          handle: "githubToken",
        },
      });

      const resolveEnvironment = makeResolver(
        persistence,
        runtimeLocalWorkspace,
      );
      const environment = yield* resolveEnvironment({
        workspaceId,
        accountId: AccountIdSchema.make("acc_params_auth"),
        executionId: ExecutionIdSchema.make("exec_params_auth"),
      });

      const invoked = (yield* environment.toolInvoker.invoke({
        path: "github.repos.getRepo",
        args: {
          owner: "vercel",
          repo: "ai",
        },
        context: {
          params: {
            githubToken: "ghp_from_params",
          },
        },
      })) as {
        ok: boolean;
        full_name: string;
      };

      expect(invoked).toEqual({
        ok: true,
        full_name: "vercel/ai",
      });
      expect(specServer.seenAuthHeaders).toEqual(["Bearer ghp_from_params"]);
    }),
  );

  it.scoped(
    "describes persisted OpenAPI tools with compact schemas and shared bundle ids",
    () =>
      Effect.gen(function* () {
        const persistence = yield* makePersistence;
        const workspaceId = WorkspaceIdSchema.make(
          "ws_openapi_describe_bundle",
        );
        const sourceId = SourceIdSchema.make("src_openapi_describe_bundle");
        const runtimeLocalWorkspace =
          yield* makeRuntimeLocalWorkspaceState(workspaceId);

        yield* persistConnectedGithubOpenApiSource({
          runtimeLocalWorkspace,
          workspaceId,
          sourceId,
        });

        const resolveEnvironment = makeResolver(
          persistence,
          runtimeLocalWorkspace,
        );
        const environment = yield* resolveEnvironment({
          workspaceId,
          accountId: AccountIdSchema.make("acc_openapi_describe_bundle"),
          executionId: ExecutionIdSchema.make("exec_openapi_describe_bundle"),
        });

        const described = (yield* environment.toolInvoker.invoke({
          path: "describe.tool",
          args: {
            path: "github.repos.getRepo",
            includeSchemas: true,
          },
        })) as {
          path: string;
          inputSchemaJson?: string;
          outputSchemaJson?: string;
          schemaBundleId?: string;
        } | null;

        expect(described?.path).toBe("github.repos.getRepo");
        expect(described?.inputSchemaJson).toContain('"owner"');
        expect(described?.outputSchemaJson).toContain('"type"');
        expect(described?.schemaBundleId).toBeDefined();

        const schemaBundle = (yield* environment.toolInvoker.invoke({
          path: "describe.schemaBundle",
          args: {
            id: described?.schemaBundleId,
          },
        })) as {
          id: string;
          kind: string;
          refsJson: string;
        } | null;

        expect(schemaBundle?.id).toBe(described?.schemaBundleId);
        expect(schemaBundle?.kind).toBe("json_schema_ref_map");
        expect(schemaBundle?.refsJson).toContain("Repository");
      }),
  );

  it.scoped(
    "describes executor.sources.add with derived type info and schemas",
    () =>
      Effect.gen(function* () {
        const persistence = yield* makePersistence;
        const workspaceId = WorkspaceIdSchema.make("ws_describe_add_source");
        const runtimeLocalWorkspace =
          yield* makeRuntimeLocalWorkspaceState(workspaceId);
        const resolveEnvironment = makeResolverWithLiveSourceAuth(
          persistence,
          runtimeLocalWorkspace,
        );

        const environment = yield* resolveEnvironment({
          workspaceId,
          accountId: AccountIdSchema.make("acc_describe_add_source"),
          executionId: ExecutionIdSchema.make("exec_describe_add_source"),
        });

        const described = (yield* environment.toolInvoker.invoke({
          path: "describe.tool",
          args: {
            path: "executor.sources.add",
            includeSchemas: true,
          },
        })) as {
          path: string;
          description?: string;
          inputType?: string;
          inputSchemaJson?: string;
        } | null;

        expect(described?.path).toBe("executor.sources.add");
        expect(described?.description).toContain("Source add input shapes:");
        expect(described?.description).toContain("specUrl");
        expect(described?.description).toContain("credential setup");
        expect(described?.inputType).toContain("endpoint");
        expect(described?.inputType).toContain("importAuth");

        const inputSchema = described?.inputSchemaJson
          ? (JSON.parse(described.inputSchemaJson) as Record<string, unknown>)
          : null;
        expect(inputSchema).not.toBeNull();
        expect(JSON.stringify(inputSchema)).toContain("specUrl");
        expect(JSON.stringify(inputSchema)).toContain("endpoint");
        expect(JSON.stringify(inputSchema)).toContain('"auth"');
        expect(JSON.stringify(inputSchema)).toContain('"importAuth"');
      }),
  );
});
