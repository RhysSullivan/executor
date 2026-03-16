import { createServer } from "node:http";

import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Schema as EffectSchema } from "effect";

import {
  type SecretRef,
  type Source,
  type SourceId,
  type WorkspaceId,
} from "@executor/control-plane";
import {
  createToolCatalogDiscovery,
  createToolCatalogFromTools,
  createSystemToolMap,
  makeToolInvokerFromTools,
  mergeToolMaps,
  type ToolCatalog,
  type ToolMap,
  type ToolPath,
  type ToolInvocationContext,
  type ToolInvoker,
} from "@executor/codemode-core";
import { createOpenApiToolsFromSpec } from "@executor/codemode-openapi";
import { makeSesExecutor } from "@executor/runtime-ses";

const asToolPath = (value: string): ToolPath => value as ToolPath;
const asSourceId = (value: string): SourceId => value as SourceId;
const asWorkspaceId = (value: string): WorkspaceId => value as WorkspaceId;

const tokenize = (value: string): string[] =>
  value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

const normalizeSearchText = (...parts: ReadonlyArray<string | null | undefined>): string =>
  parts
    .flatMap((part) => {
      const normalized = part?.trim();
      return normalized ? [normalized] : [];
    })
    .join(" ")
    .toLowerCase();

const catalogNamespaceFromPath = (path: string): string => {
  const [first, second] = path.split(".");
  return second ? `${first}.${second}` : first;
};

type StoredToolArtifactRecord = {
  workspaceId: WorkspaceId;
  path: string;
  toolId: string;
  sourceId: SourceId;
  title: string | null;
  description: string | null;
  searchNamespace: string;
  searchText: string;
  inputSchema: unknown | null;
  outputSchema: unknown | null;
  providerKind: "openapi";
  openApiMethod: "get" | "put" | "post" | "delete" | "patch" | "head" | "options" | "trace";
  openApiPathTemplate: string | null;
  openApiOperationHash: string | null;
  openApiRawToolId: string | null;
  openApiOperationId: string | null;
  openApiTagsJson: string | null;
  openApiRequestBodyRequired: boolean | null;
  createdAt: number;
  updatedAt: number;
};

const toDescriptor = (
  artifact: StoredToolArtifactRecord,
  includeSchemas: boolean,
) => ({
  path: asToolPath(artifact.path),
  sourceKey: artifact.sourceId,
  description: artifact.description ?? artifact.title ?? undefined,
  interaction: "auto" as const,
  inputTypePreview: includeSchemas && artifact.inputSchema ? "object" : undefined,
  outputTypePreview: includeSchemas && artifact.outputSchema ? "output" : undefined,
  inputSchema: includeSchemas ? artifact.inputSchema ?? undefined : undefined,
  outputSchema: includeSchemas ? artifact.outputSchema ?? undefined : undefined,
});

type SourceCallContext = {
  auth:
    | { kind: "none" }
    | {
        kind: "headers";
        headers: Record<string, string>;
      };
};

interface SecretMaterialProvider {
  providerId: string;
  get(input: {
    handle: string;
  }): Promise<string>;
}

interface SecretMaterialRegistry {
  get(input: {
    ref: SecretRef;
  }): Promise<string>;
}

interface ProviderInvoker {
  invoke(input: {
    source: Source;
    artifact: StoredToolArtifactRecord;
    args: unknown;
    runtime: SourceCallContext;
    context?: ToolInvocationContext;
  }): Promise<unknown>;
}

type WorkspaceScopedSourceStore = {
  registerSource(input: {
    workspaceId: WorkspaceId;
    source: Source;
  }): Promise<void>;
  getById(input: {
    sourceId: SourceId;
  }): Promise<Source | null>;
};

type WorkspaceScopedToolStore = {
  indexArtifacts(input: {
    workspaceId: WorkspaceId;
    artifacts: readonly StoredToolArtifactRecord[];
  }): Promise<void>;
  listNamespaces(input: {
    workspaceId: WorkspaceId;
    limit?: number;
  }): Promise<
    readonly {
      namespace: string;
      toolCount: number;
    }[]
  >;
  list(input: {
    workspaceId: WorkspaceId;
    query?: string;
    namespace?: string;
    limit?: number;
  }): Promise<readonly StoredToolArtifactRecord[]>;
  getByPath(input: {
    workspaceId: WorkspaceId;
    path: ToolPath;
  }): Promise<StoredToolArtifactRecord | null>;
};

const createInMemorySourceStore = (): WorkspaceScopedSourceStore => {
  const byWorkspace = new Map<string, Map<string, Source>>();

  const getWorkspaceMap = (workspaceId: WorkspaceId) => {
    const existing = byWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, Source>();
    byWorkspace.set(workspaceId, created);
    return created;
  };

  return {
    async registerSource({ workspaceId, source }) {
      getWorkspaceMap(workspaceId).set(source.id, source);
    },
    async getById({ sourceId }) {
      for (const workspace of byWorkspace.values()) {
        const source = workspace.get(sourceId);
        if (source) {
          return source;
        }
      }
      return null;
    },
  };
};

const createInMemoryToolStore = (): WorkspaceScopedToolStore => {
  const byWorkspace = new Map<string, Map<string, StoredToolArtifactRecord>>();

  const getWorkspaceMap = (workspaceId: WorkspaceId) => {
    const existing = byWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, StoredToolArtifactRecord>();
    byWorkspace.set(workspaceId, created);
    return created;
  };

  return {
    async indexArtifacts({ workspaceId, artifacts }) {
      const workspace = getWorkspaceMap(workspaceId);
      for (const artifact of artifacts) {
        workspace.set(artifact.path, artifact);
      }
    },
    async listNamespaces({ workspaceId, limit = 200 }) {
      const counts = new Map<string, number>();
      for (const artifact of getWorkspaceMap(workspaceId).values()) {
        counts.set(
          artifact.searchNamespace,
          (counts.get(artifact.searchNamespace) ?? 0) + 1,
        );
      }

      return [...counts.entries()]
        .map(([namespace, toolCount]) => ({
          namespace,
          toolCount,
        }))
        .sort((left, right) => left.namespace.localeCompare(right.namespace))
        .slice(0, limit);
    },
    async list({ workspaceId, namespace, query, limit = 200 }) {
      return [...getWorkspaceMap(workspaceId).values()]
        .filter((artifact) => !namespace || artifact.searchNamespace === namespace)
        .filter((artifact) =>
          !query || tokenize(query).every((token) => artifact.searchText.includes(token))
        )
        .slice(0, limit);
    },
    async getByPath({ workspaceId, path }) {
      return getWorkspaceMap(workspaceId).get(path) ?? null;
    },
  };
};

const createStaticSecretProvider = (
  providerId: string,
  values: Record<string, string>,
): SecretMaterialProvider => {
  const handles = new Map(Object.entries(values));

  return {
    providerId,
    async get({ handle }) {
      const value = handles.get(handle);
      if (!value) {
        throw new Error(`Unknown secret handle ${providerId}:${handle}`);
      }
      return value;
    },
  };
};

const createSecretRegistry = (
  providers: readonly SecretMaterialProvider[],
): SecretMaterialRegistry => {
  const byId = new Map(providers.map((provider) => [provider.providerId, provider]));

  return {
    async get({ ref }) {
      const provider = byId.get(ref.providerId);
      if (!provider) {
        throw new Error(`Unknown secret provider ${ref.providerId}`);
      }
      return provider.get({ handle: ref.handle });
    },
  };
};

const resolveSourceCallContext = (input: {
  secretRegistry: SecretMaterialRegistry;
}) =>
  async (source: Source): Promise<SourceCallContext> => {
    switch (source.auth.kind) {
      case "none":
        return { auth: { kind: "none" } };
      case "bearer": {
        const token = await input.secretRegistry.get({ ref: source.auth.token });
        return {
          auth: {
            kind: "headers",
            headers: {
              [source.auth.headerName]: `${source.auth.prefix}${token}`,
            },
          },
        };
      }
      case "oauth2": {
        const token = await input.secretRegistry.get({ ref: source.auth.accessToken });
        return {
          auth: {
            kind: "headers",
            headers: {
              [source.auth.headerName]: `${source.auth.prefix}${token}`,
            },
          },
        };
      }
      case "oauth2_authorized_user":
        throw new Error("oauth2_authorized_user auth requires persistence-backed runtime resolution");
      case "provider_grant_ref":
        throw new Error("provider_grant_ref auth requires persistence-backed runtime resolution");
      case "mcp_oauth":
        throw new Error("mcp_oauth auth requires persistence-backed runtime resolution");
    }
  };

const createProviderInvoker = (): ProviderInvoker => ({
  async invoke({ source, artifact, args, runtime, context }) {
    const invocation = {
      method: artifact.openApiMethod,
      pathTemplate: artifact.openApiPathTemplate,
      operationHash: artifact.openApiOperationHash,
    };

    return {
      sourceId: source.id,
      path: artifact.path,
      provider: artifact.providerKind,
      invocation,
      args,
      auth: runtime.auth,
      workspaceId: context?.workspaceId ?? null,
      runId: context?.runId ?? null,
    };
  },
});

const createWorkspaceToolCatalog = (input: {
  workspaceId: WorkspaceId;
  toolStore: WorkspaceScopedToolStore;
}): ToolCatalog => ({
  listNamespaces: ({ limit }) =>
    Effect.promise(() =>
      input.toolStore.listNamespaces({
        workspaceId: input.workspaceId,
        limit,
      }).then((namespaces) =>
        namespaces.map((namespace) => ({
          namespace: namespace.namespace,
          toolCount: namespace.toolCount,
        }))
      )
    ),
  listTools: ({ namespace, query, limit, includeSchemas = false }) =>
    Effect.promise(() =>
      input.toolStore.list({
        workspaceId: input.workspaceId,
        ...(namespace !== undefined ? { namespace } : {}),
        ...(query !== undefined ? { query } : {}),
        limit,
      }).then((artifacts) => artifacts.map((artifact) => toDescriptor(artifact, includeSchemas)))
    ),
  getToolByPath: ({ path, includeSchemas }) =>
    Effect.promise(() =>
      input.toolStore.getByPath({
        workspaceId: input.workspaceId,
        path,
      }).then((artifact) => (artifact ? toDescriptor(artifact, includeSchemas) : null))
    ),
  searchTools: ({ query, namespace, limit }) =>
    Effect.promise(() =>
      input.toolStore.list({
        workspaceId: input.workspaceId,
        ...(namespace !== undefined ? { namespace } : {}),
        query,
        limit: 500,
      }).then((artifacts) => {
        const queryTokens = tokenize(query);

        return artifacts
          .map((artifact) => {
            const score = queryTokens.reduce(
              (total, token) => total + (artifact.searchText.includes(token) ? 1 : 0),
              0,
            );

            return {
              path: asToolPath(artifact.path),
              score,
            };
          })
          .filter((hit) => hit.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);
      })
    ),
});

const createWorkspaceToolInvoker = (input: {
  workspaceId: WorkspaceId;
  sourceStore: WorkspaceScopedSourceStore;
  toolStore: WorkspaceScopedToolStore;
  resolveSourceCallContext: (source: Source) => Promise<SourceCallContext>;
  providerInvoker: ProviderInvoker;
}): ToolInvoker => ({
  invoke: (() => {
    const catalog = createWorkspaceToolCatalog({
      workspaceId: input.workspaceId,
      toolStore: input.toolStore,
    });
    const systemTools = createSystemToolMap({
      catalog,
      sourceKey: "system",
    });
    const systemToolPaths = new Set(Object.keys(systemTools));
    const systemToolInvoker = makeToolInvokerFromTools({
      tools: systemTools,
      sourceKey: "system",
    });

    return ({ path, args, context }) =>
      systemToolPaths.has(path)
        ? systemToolInvoker.invoke({ path, args, context })
        : Effect.tryPromise({
          try: async () => {
        const mergedContext: ToolInvocationContext = {
          ...context,
          workspaceId: input.workspaceId,
        };

        const artifact = await input.toolStore.getByPath({
          workspaceId: input.workspaceId,
          path: asToolPath(path),
        });
        if (!artifact) {
          throw new Error(`Unknown tool path: ${path}`);
        }

        const source = await input.sourceStore.getById({
          sourceId: artifact.sourceId,
        });
        if (!source) {
          throw new Error(`Unknown source for tool path: ${path}`);
        }

        const runtime = await input.resolveSourceCallContext(source);

        return input.providerInvoker.invoke({
          source,
          artifact,
          args,
          runtime,
          context: mergedContext,
        });
          },
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
  })(),
});

const toolInvokerFromWorkspace = (input: {
  workspaceId: WorkspaceId;
  sourceStore: WorkspaceScopedSourceStore;
  toolStore: WorkspaceScopedToolStore;
  secretRegistry: SecretMaterialRegistry;
  providerInvoker?: ProviderInvoker;
}): ToolInvoker =>
  createWorkspaceToolInvoker({
    workspaceId: input.workspaceId,
    sourceStore: input.sourceStore,
    toolStore: input.toolStore,
    resolveSourceCallContext: resolveSourceCallContext({
      secretRegistry: input.secretRegistry,
    }),
    providerInvoker: input.providerInvoker ?? createProviderInvoker(),
  });

const bearerSourceAuth = (input: {
  providerId: string;
  handle: string;
}): Source["auth"] => ({
  kind: "bearer",
  headerName: "Authorization",
  prefix: "Bearer ",
  token: {
    providerId: input.providerId,
    handle: input.handle,
  },
});

const openApiSource = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  displayName: string;
  baseUrl: string;
  specUrl?: string;
  namespace?: string;
  auth: Source["auth"];
}): Source => ({
  id: input.sourceId,
  workspaceId: input.workspaceId,
  name: input.displayName,
  kind: "openapi",
  endpoint: input.baseUrl,
  status: "connected",
  enabled: true,
  namespace: input.namespace ?? null,
  bindingVersion: 1,
  binding: {
    specUrl: input.specUrl ?? null,
    defaultHeaders: null,
  },
  importAuthPolicy: "reuse_runtime",
  importAuth: { kind: "none" },
  auth: input.auth,
  sourceHash: null,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
});

const openApiArtifact = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  path: ToolPath;
  toolId: string;
  title: string;
  description?: string;
  method: NonNullable<StoredToolArtifactRecord["openApiMethod"]>;
  pathTemplate: string;
  operationHash?: string;
  inputSchema?: unknown | null;
  outputSchema?: unknown | null;
}): StoredToolArtifactRecord => {
  const path = input.path as string;
  const description =
    input.description ?? `${input.method.toUpperCase()} ${input.pathTemplate}`;

  return {
    workspaceId: input.workspaceId,
    path,
    toolId: input.toolId,
    sourceId: input.sourceId,
    title: input.title,
    description,
    searchNamespace: catalogNamespaceFromPath(path),
    searchText: normalizeSearchText(
      path,
      catalogNamespaceFromPath(path),
      input.title,
      description,
      input.method.toUpperCase(),
      input.pathTemplate,
    ),
    inputSchema: input.inputSchema ?? null,
    outputSchema: input.outputSchema ?? null,
    providerKind: "openapi",
    openApiMethod: input.method,
    openApiPathTemplate: input.pathTemplate,
    openApiOperationHash: input.operationHash ?? input.toolId,
    openApiRawToolId: input.toolId,
    openApiOperationId: input.toolId,
    openApiTagsJson: null,
    openApiRequestBodyRequired: null,
    createdAt: 0,
    updatedAt: 0,
  };
};

const numberPairInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    a: Schema.Number,
    b: Schema.Number,
  }),
);

const createDiscoveryBackedToolMap = (input: {
  tools: ToolMap;
  namespace: string;
  sourceKey?: string;
}) => {
  const sourceKey = input.sourceKey ?? "in_memory.tools";
  const catalog = createToolCatalogFromTools({
    tools: input.tools,
    defaultNamespace: input.namespace,
  });
  const discovery = createToolCatalogDiscovery({ catalog });

  return {
    executeDescription: discovery.executeDescription,
    tools: mergeToolMaps([
      input.tools,
      createSystemToolMap({
        catalog,
        sourceKey,
      }),
    ]),
  };
};

const ownerParam = HttpApiSchema.param("owner", EffectSchema.String);
const repoParam = HttpApiSchema.param("repo", EffectSchema.String);

class GeneratedReposApi extends HttpApiGroup.make("repos")
  .add(
    HttpApiEndpoint.get("getRepo")`/repos/${ownerParam}/${repoParam}`
      .addSuccess(EffectSchema.Unknown),
  ) {}

class GeneratedApi extends HttpApi.make("generated").add(GeneratedReposApi) {}

const generatedOpenApiSpec = OpenApi.fromApi(GeneratedApi);

type OpenApiTestServer = {
  baseUrl: string;
  requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
  }>;
  close: () => Promise<void>;
};

const makeOpenApiTestServer = Effect.acquireRelease(
  Effect.promise<OpenApiTestServer>(
    () =>
      new Promise<OpenApiTestServer>((resolve, reject) => {
        const requests: OpenApiTestServer["requests"] = [];

        const server = createServer((req, res) => {
          requests.push({
            method: req.method ?? "GET",
            path: req.url ?? "/",
            authorization:
              typeof req.headers.authorization === "string"
                ? req.headers.authorization
                : null,
          });

          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              ok: true,
              path: req.url ?? "/",
              authorization:
                typeof req.headers.authorization === "string"
                  ? req.headers.authorization
                  : null,
            }),
          );
        });

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("failed to resolve test server address"));
            return;
          }

          resolve({
            baseUrl: `http://127.0.0.1:${address.port}`,
            requests,
            close: async () => {
              await new Promise<void>((closeResolve, closeReject) => {
                server.close((error) => {
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
      }),
  ),
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(Effect.orDie),
);

describe("source runtime", () => {
  it.effect("searches serialized workspace tools and calls one", () =>
    Effect.gen(function* () {
      const workspaceId = asWorkspaceId("workspace_123");
      const sourceStore = createInMemorySourceStore();
      const toolStore = createInMemoryToolStore();
      const secretRegistry = createSecretRegistry([
        createStaticSecretProvider("local", {
          "github-db-token": "ghp_from_db",
        }),
      ]);

      const githubSource = openApiSource({
        workspaceId,
        sourceId: asSourceId("github"),
        displayName: "GitHub API",
        baseUrl: "https://api.github.com",
        specUrl: "https://api.github.com/openapi.json",
        namespace: "github",
        auth: bearerSourceAuth({
          providerId: "local",
          handle: "github-db-token",
        }),
      });

      yield* Effect.promise(() =>
        sourceStore.registerSource({
          workspaceId,
          source: githubSource,
        })
      );
      yield* Effect.promise(() =>
        toolStore.indexArtifacts({
          workspaceId,
          artifacts: [
            openApiArtifact({
              workspaceId,
              sourceId: githubSource.id,
              path: asToolPath("github.issues.list"),
              toolId: "issues.list",
              title: "List issues",
              description: "Serialized artifact loaded from a database row",
              method: "get",
              pathTemplate: "/repos/{owner}/{repo}/issues",
            }),
          ],
        })
      );

      const toolInvoker = toolInvokerFromWorkspace({
        workspaceId,
        sourceStore,
        toolStore,
        secretRegistry,
      });
      const workspaceCatalog = createWorkspaceToolCatalog({
        workspaceId,
        toolStore,
      });
      const executeDescription = yield* createToolCatalogDiscovery({
        catalog: workspaceCatalog,
      }).executeDescription;

      const output = yield* makeSesExecutor().execute(
        [
          'const matches = await tools.discover({ query: "github issues", limit: 3 });',
          "const result = await tools.github.issues.list({ owner: 'vercel', repo: 'next.js' });",
          "return { matches, result };",
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toMatchObject({
        matches: {
          bestPath: "github.issues.list",
          results: [
            {
              path: "github.issues.list",
              score: expect.any(Number),
              description: "Serialized artifact loaded from a database row",
              interaction: "auto",
            },
          ],
          total: 1,
        },
        result: {
          provider: "openapi",
          path: "github.issues.list",
          auth: {
            kind: "headers",
            headers: {
              Authorization: "Bearer ghp_from_db",
            },
          },
          workspaceId,
        },
      });
      expect(executeDescription).toBe(
        [
          "Execute TypeScript in sandbox; call tools via discovery workflow.",
          "Available namespaces:",
          "- github.issues",
          "Workflow:",
          '1) const matches = await tools.discover({ query: "<intent>", limit: 12 });',
          "2) const details = await tools.describe.tool({ path, includeSchemas: true });",
          "3) Read details.inputSchema/details.outputSchema when you need the projected shape.",
          "4) Call selected tools.<path>(input).",
          "Do not use fetch; use tools.* only.",
        ].join("\n"),
      );
    }),
  );

  it.scoped("loads an api from inline sources and calls it", () =>
    Effect.gen(function* () {
      const server = yield* makeOpenApiTestServer;

      const extracted = yield* createOpenApiToolsFromSpec({
        sourceName: "github",
        openApiSpec: generatedOpenApiSpec,
        baseUrl: server.baseUrl,
        namespace: "github",
        credentialHeaders: {
          Authorization: "Bearer ghp_from_keychain",
        },
      });

      const discoveryBacked = createDiscoveryBackedToolMap({
        tools: extracted.tools,
        namespace: "github",
        sourceKey: "github.openapi",
      });

      const toolInvoker = makeToolInvokerFromTools({
        tools: discoveryBacked.tools,
      });

      const output = yield* makeSesExecutor().execute(
        [
          'const matches = await tools.discover({ query: "github repo", limit: 3 });',
          "const result = await tools.github.repos.getRepo({ owner: 'vercel', repo: 'ai' });",
          "return { matches, result };",
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toEqual({
        matches: {
          bestPath: "github.repos.getRepo",
          results: [
            {
              path: "github.repos.getRepo",
              score: expect.any(Number),
              description: "GET /repos/{owner}/{repo}",
              interaction: "auto",
              inputTypePreview: "{ owner: string, repo: string }",
              outputTypePreview: "unknown",
            },
          ],
          total: 1,
        },
        result: {
          ok: true,
          path: "/repos/vercel/ai",
          authorization: "Bearer ghp_from_keychain",
        },
      });
      expect(yield* discoveryBacked.executeDescription).toBe(
        [
          "Execute TypeScript in sandbox; call tools via discovery workflow.",
          "Available namespaces:",
          "- github",
          "Workflow:",
          '1) const matches = await tools.discover({ query: "<intent>", limit: 12 });',
          "2) const details = await tools.describe.tool({ path, includeSchemas: true });",
          "3) Read details.inputSchema/details.outputSchema when you need the projected shape.",
          "4) Call selected tools.<path>(input).",
          "Do not use fetch; use tools.* only.",
        ].join("\n"),
      );
      expect(server.requests).toEqual([
        {
          method: "GET",
          path: "/repos/vercel/ai",
          authorization: "Bearer ghp_from_keychain",
        },
      ]);
    }),
  );

  it.effect("basic calling of tools via codemode", () =>
    Effect.gen(function* () {
      const toolInvoker = makeToolInvokerFromTools({
        tools: {
          "math.add": {
            description: "Add two numbers",
            inputSchema: numberPairInputSchema,
            execute: ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
          },
        },
      });

      const output = yield* makeSesExecutor().execute(
        "return await tools.math.add({ a: 20, b: 22 });",
        toolInvoker,
      );

      expect(output.result).toEqual({ sum: 42 });
    }),
  );
});
