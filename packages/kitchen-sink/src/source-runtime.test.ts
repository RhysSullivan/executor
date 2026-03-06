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
} from "@executor-v3/codemode-core";
import {
  type CredentialBinding,
  type ProviderInvoker,
  type SecretMaterialRegistry,
  type SecretMaterialProvider,
  type SourceCallContext,
  type SourceDefinition,
  type SourceKey,
  type SourceRuntimeResolver,
  type ToolArtifact,
  asSourceKey,
} from "@executor-v3/control-plane";
import { createOpenApiToolsFromSpec } from "@executor-v3/codemode-openapi";
import { makeInProcessExecutor } from "@executor-v3/runtime-local-inproc";

const asToolPath = (value: string): ToolPath => value as ToolPath;

type WorkspaceScopedSourceStore = {
  registerSource(input: {
    workspaceId: string;
    source: SourceDefinition;
  }): Promise<void>;
  listSources(input: {
    workspaceId: string;
    limit?: number;
  }): Promise<
    readonly {
      sourceKey: SourceKey;
      displayName: string;
    }[]
  >;
  getByKey(input: {
    sourceKey: SourceKey;
  }): Promise<SourceDefinition | null>;
};

type WorkspaceScopedToolStore = {
  indexArtifacts(input: {
    workspaceId: string;
    sourceKey: SourceKey;
    artifacts: readonly ToolArtifact[];
  }): Promise<void>;
  list(input: {
    workspaceId: string;
    sourceKey?: SourceKey;
    query?: string;
    limit?: number;
  }): Promise<readonly ToolArtifact[]>;
  getByPath(input: {
    workspaceId: string;
    path: ToolPath;
  }): Promise<ToolArtifact | null>;
};

type WorkspaceScopedBindingStore = {
  put(input: {
    workspaceId: string;
    binding: CredentialBinding;
  }): Promise<void>;
  getBySourceKey(input: {
    workspaceId: string;
    sourceKey: SourceKey;
  }): Promise<CredentialBinding | null>;
};

const createInMemorySourceStore = (): WorkspaceScopedSourceStore => {
  const byWorkspace = new Map<string, Map<string, SourceDefinition>>();

  const getWorkspaceMap = (workspaceId: string) => {
    const existing = byWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, SourceDefinition>();
    byWorkspace.set(workspaceId, created);
    return created;
  };

  return {
    async registerSource({ workspaceId, source }) {
      getWorkspaceMap(workspaceId).set(source.sourceKey, source);
    },
    async listSources({ workspaceId, limit = 200 }) {
      return [...getWorkspaceMap(workspaceId).values()]
        .slice(0, limit)
        .map((source) => ({
          sourceKey: source.sourceKey,
          displayName: source.displayName,
        }));
    },
    async getByKey({ sourceKey }) {
      for (const workspace of byWorkspace.values()) {
        const source = workspace.get(sourceKey);
        if (source) {
          return source;
        }
      }
      return null;
    },
  };
};

const createInMemoryToolStore = (): WorkspaceScopedToolStore => {
  const byWorkspace = new Map<string, Map<string, ToolArtifact>>();

  const getWorkspaceMap = (workspaceId: string) => {
    const existing = byWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, ToolArtifact>();
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
    async list({ workspaceId, sourceKey, query, limit = 200 }) {
      return [...getWorkspaceMap(workspaceId).values()]
        .filter((artifact) => !sourceKey || artifact.sourceKey === sourceKey)
        .filter((artifact) =>
          !query
            || [
              artifact.path,
              artifact.title ?? "",
              artifact.description ?? "",
              artifact.search.namespace,
              ...artifact.search.keywords,
            ]
              .join(" ")
              .toLowerCase()
              .includes(query.toLowerCase())
        )
        .slice(0, limit);
    },
    async getByPath({ workspaceId, path }) {
      return getWorkspaceMap(workspaceId).get(path) ?? null;
    },
  };
};

const createInMemoryBindingStore = (): WorkspaceScopedBindingStore => {
  const byWorkspace = new Map<string, Map<string, CredentialBinding>>();

  const getWorkspaceMap = (workspaceId: string) => {
    const existing = byWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, CredentialBinding>();
    byWorkspace.set(workspaceId, created);
    return created;
  };

  return {
    async put(input) {
      const workspaceId = "workspaceId" in input ? input.workspaceId : "default";
      getWorkspaceMap(workspaceId).set(input.binding.sourceKey, input.binding);
    },
    async getBySourceKey(input) {
      const workspaceId = "workspaceId" in input ? input.workspaceId : "default";
      return getWorkspaceMap(workspaceId).get(input.sourceKey) ?? null;
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

const createSourceRuntimeResolver = (input: {
  bindingStore: WorkspaceScopedBindingStore;
  secretRegistry: SecretMaterialRegistry;
}): SourceRuntimeResolver => ({
  async resolveForCall({ source, context }) {
    if (source.auth.kind === "none") {
      return { auth: { kind: "none" } };
    }

    const workspaceId =
      typeof context?.workspaceId === "string" ? context.workspaceId : "default";

    const binding = await input.bindingStore.getBySourceKey({
      workspaceId,
      sourceKey: source.sourceKey,
    });
    if (!binding) {
      throw new Error(`Missing credential binding for source ${source.sourceKey}`);
    }

    if (source.auth.kind === "bearer" || source.auth.kind === "oauth2") {
      const ref = binding.materials.token ?? binding.materials.accessToken;
      if (!ref) {
        throw new Error(`Missing token material for source ${source.sourceKey}`);
      }

      const token = await input.secretRegistry.get({ ref });
      return {
        auth: {
          kind: "headers",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      } satisfies SourceCallContext;
    }

    if (source.auth.kind === "apiKey") {
      const ref = binding.materials.apiKey;
      if (!ref) {
        throw new Error(`Missing apiKey material for source ${source.sourceKey}`);
      }

      const apiKey = await input.secretRegistry.get({ ref });
      return source.auth.in === "header"
        ? {
            auth: {
              kind: "headers",
              headers: {
                [source.auth.name]: apiKey,
              },
            },
          }
        : {
            auth: {
              kind: "query",
              queryParams: {
                [source.auth.name]: apiKey,
              },
            },
          };
    }

    return {
      auth: {
        kind: "composite",
        values: {
          sourceKind: source.kind,
        },
      },
    };
  },
});

const createProviderInvoker = (): ProviderInvoker => ({
  async invoke({ source, artifact, args, runtime, context }) {
    return {
      sourceKey: source.sourceKey,
      path: artifact.path,
      provider: artifact.invocation.provider,
      invocation: artifact.invocation,
      args,
      auth: runtime.auth,
      workspaceId: context?.workspaceId ?? null,
      runId: context?.runId ?? null,
    };
  },
});

const createWorkspaceToolCatalog = (input: {
  workspaceId: string;
  sourceStore: WorkspaceScopedSourceStore;
  toolStore: WorkspaceScopedToolStore;
}): ToolCatalog => ({
  listNamespaces: ({ limit }) =>
    Effect.promise(() =>
      input.sourceStore.listSources({
        workspaceId: input.workspaceId,
        limit,
      }).then((sources) =>
        sources.map((source) => ({
          namespace: source.sourceKey as string,
          displayName: source.displayName,
          toolCount: undefined,
        }))
      )
    ),
  listTools: ({ namespace, query, limit, includeSchemas = false }) =>
    Effect.promise(() =>
      input.toolStore.list({
        workspaceId: input.workspaceId,
        ...(namespace !== undefined ? { sourceKey: namespace as SourceKey } : {}),
        ...(query !== undefined ? { query } : {}),
        limit,
      }).then((artifacts) =>
        artifacts.map((artifact) => ({
          path: artifact.path as any,
          sourceKey: artifact.sourceKey,
          description: artifact.description ?? artifact.title,
          interaction: "auto" as const,
          inputHint: includeSchemas && artifact.inputSchemaJson ? "object" : undefined,
          outputHint: includeSchemas && artifact.outputSchemaJson ? "output" : undefined,
          inputSchemaJson: includeSchemas ? artifact.inputSchemaJson : undefined,
          outputSchemaJson: includeSchemas ? artifact.outputSchemaJson : undefined,
        }))
      )
    ),
  getToolByPath: ({ path, includeSchemas }) =>
    Effect.promise(() =>
      input.toolStore.getByPath({
        workspaceId: input.workspaceId,
        path: path as ToolPath,
      }).then((artifact) =>
        artifact
          ? {
              path: artifact.path as any,
              sourceKey: artifact.sourceKey,
              description: artifact.description ?? artifact.title,
              interaction: "auto" as const,
              inputHint: includeSchemas && artifact.inputSchemaJson ? "object" : undefined,
              outputHint: includeSchemas && artifact.outputSchemaJson ? "output" : undefined,
              inputSchemaJson: includeSchemas ? artifact.inputSchemaJson : undefined,
              outputSchemaJson: includeSchemas ? artifact.outputSchemaJson : undefined,
            }
          : null
      )
    ),
  searchTools: ({ query, namespace, limit }) =>
    Effect.promise(() =>
      input.toolStore.list({
        workspaceId: input.workspaceId,
        ...(namespace !== undefined ? { sourceKey: namespace as SourceKey } : {}),
        ...(query !== undefined ? { query } : {}),
        limit: 500,
      }).then((artifacts) => {
        const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);

        return artifacts
          .map((artifact) => {
            const haystack = [
              artifact.path,
              artifact.title ?? "",
              artifact.description ?? "",
              artifact.search.namespace,
              ...artifact.search.keywords,
            ].join(" ").toLowerCase();

            const score = queryTokens.reduce(
              (total, token) => total + (haystack.includes(token) ? 1 : 0),
              0,
            );

            return {
              path: artifact.path as any,
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
  workspaceId: string;
  sourceStore: WorkspaceScopedSourceStore;
  toolStore: WorkspaceScopedToolStore;
  runtimeResolver: SourceRuntimeResolver;
  providerInvoker: ProviderInvoker;
}): ToolInvoker => ({
  invoke: (() => {
    const catalog = createWorkspaceToolCatalog({
      workspaceId: input.workspaceId,
      sourceStore: input.sourceStore,
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

        const source = await input.sourceStore.getByKey({
          sourceKey: artifact.sourceKey,
        });
        if (!source) {
          throw new Error(`Unknown source for tool path: ${path}`);
        }

        const runtime = await input.runtimeResolver.resolveForCall({
          source,
          artifact,
          context: mergedContext,
        });

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
  workspaceId: string;
  sourceStore: WorkspaceScopedSourceStore;
  toolStore: WorkspaceScopedToolStore;
  bindingStore: WorkspaceScopedBindingStore;
  secretRegistry: SecretMaterialRegistry;
  providerInvoker?: ProviderInvoker;
}): ToolInvoker =>
  createWorkspaceToolInvoker({
    workspaceId: input.workspaceId,
    sourceStore: input.sourceStore,
    toolStore: input.toolStore,
    runtimeResolver: createSourceRuntimeResolver({
      bindingStore: input.bindingStore,
      secretRegistry: input.secretRegistry,
    }),
    providerInvoker: input.providerInvoker ?? createProviderInvoker(),
  });

const bearerBinding = (input: {
  sourceKey: SourceKey;
  providerId: string;
  handle: string;
}): CredentialBinding => ({
  sourceKey: input.sourceKey,
  authScheme: { kind: "bearer" },
  materials: {
    token: {
      providerId: input.providerId,
      handle: input.handle,
    },
  },
});

const openApiSource = (input: {
  sourceKey: SourceKey;
  displayName: string;
  baseUrl: string;
  specUrl?: string;
  auth: SourceDefinition["auth"];
}): SourceDefinition => ({
  sourceKey: input.sourceKey,
  displayName: input.displayName,
  kind: "openapi",
  enabled: true,
  auth: input.auth,
  connection: {
    specUrl: input.specUrl,
    baseUrl: input.baseUrl,
  },
});

const numberPairInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    a: Schema.Number,
    b: Schema.Number,
  }),
);

const createDiscoveryBackedToolMap = (input: {
  tools: ToolMap;
  namespace: string;
  displayName?: string;
  sourceKey?: string;
}) => {
  const sourceKey = asSourceKey(input.sourceKey ?? "in_memory.tools");
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
      const workspaceId = "workspace_123";
      const sourceStore = createInMemorySourceStore();
      const toolStore = createInMemoryToolStore();
      const bindingStore = createInMemoryBindingStore();
      const secretRegistry = createSecretRegistry([
        createStaticSecretProvider("postgres", {
          "github-db-token": "ghp_from_db",
        }),
      ]);

      const githubSource = openApiSource({
        sourceKey: asSourceKey("github"),
        displayName: "GitHub API",
        baseUrl: "https://api.github.com",
        specUrl: "https://api.github.com/openapi.json",
        auth: { kind: "bearer" },
      });

      yield* Effect.promise(() =>
        sourceStore.registerSource({
          workspaceId,
          source: githubSource,
        })
      );
      yield* Effect.promise(() =>
        bindingStore.put({
          workspaceId,
          binding: bearerBinding({
            sourceKey: githubSource.sourceKey,
            providerId: "postgres",
            handle: "github-db-token",
          }),
        })
      );
      yield* Effect.promise(() =>
        toolStore.indexArtifacts({
          workspaceId,
          sourceKey: githubSource.sourceKey,
          artifacts: [
            {
              path: asToolPath("github.issues.list"),
              sourceKey: githubSource.sourceKey,
              title: "List issues",
              description: "Serialized artifact loaded from a database row",
              invocation: {
                provider: "openapi",
                operationId: "issues.list",
                method: "get",
                pathTemplate: "/repos/{owner}/{repo}/issues",
              },
              search: {
                namespace: "github.issues",
                keywords: ["github", "issues", "list", "serialized", "db"],
              },
            },
          ],
        })
      );

      const toolInvoker = toolInvokerFromWorkspace({
        workspaceId,
        sourceStore,
        toolStore,
        bindingStore,
        secretRegistry,
      });
      const workspaceCatalog = createWorkspaceToolCatalog({
        workspaceId,
        sourceStore,
        toolStore,
      });
      const executeDescription = yield* createToolCatalogDiscovery({
        catalog: workspaceCatalog,
      }).executeDescription;

      const output = yield* makeInProcessExecutor().execute(
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
          "- GitHub API",
          "Workflow:",
          '1) const matches = await tools.discover({ query: "<intent>", limit: 12 });',
          "2) const details = await tools.describe.tool({ path, includeSchemas: true });",
          "3) Call selected tools.<path>(input).",
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
        displayName: "GitHub API",
        sourceKey: "github.openapi",
      });

      const toolInvoker = makeToolInvokerFromTools({
        tools: discoveryBacked.tools,
      });

      const output = yield* makeInProcessExecutor().execute(
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
              inputHint: "object { owner, repo }",
              outputHint: "unknown",
            },
          ],
          total: 1,
        },
        result: {
          status: 200,
          headers: expect.any(Object),
          body: {
            ok: true,
            path: "/repos/vercel/ai",
            authorization: "Bearer ghp_from_keychain",
          },
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
          "3) Call selected tools.<path>(input).",
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

      const output = yield* makeInProcessExecutor().execute(
        "return await tools.math.add({ a: 20, b: 22 });",
        toolInvoker,
      );

      expect(output.result).toEqual({ sum: 42 });
    }),
  );
});
