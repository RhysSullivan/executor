import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  buildOpenApiToolPresentation,
  compileOpenApiToolDefinitions,
  extractOpenApiManifest,
} from "@executor/codemode-openapi";

import {
  AccountIdSchema,
  OrganizationIdSchema,
  SourceIdSchema,
  SourceRecipeIdSchema,
  SourceRecipeRevisionIdSchema,
  WorkspaceIdSchema,
  type Source,
  type StoredSourceRecipeOperationRecord,
} from "#schema";
import {
  createSqlControlPlanePersistence,
  type SqlControlPlanePersistence,
} from "#persistence";

import {
  expandRecipeTools,
  loadSourceWithRecipe,
  loadWorkspaceSourceRecipes,
  recipeToolDescriptor,
  recipeToolPath,
  recipeToolSearchNamespace,
  type LoadedSourceRecipe,
} from "./source-recipes-runtime";

const makePersistence = () =>
  Effect.runPromise(
    createSqlControlPlanePersistence({
      localDataDir: ":memory:",
    }),
  );

const openApiBindingConfigJson = (specUrl: string): string =>
  JSON.stringify({
    adapterKey: "openapi",
    version: 1,
    payload: {
      specUrl,
      defaultHeaders: null,
    },
  });

const graphqlBindingConfigJson = (): string =>
  JSON.stringify({
    adapterKey: "graphql",
    version: 1,
    payload: {
      defaultHeaders: null,
    },
  });

const makeSource = (overrides: Partial<Source> = {}): Source => {
  const kind = overrides.kind ?? "openapi";
  const endpoint = overrides.endpoint
    ?? (kind === "graphql"
      ? "https://example.com/graphql"
      : kind === "mcp"
        ? "https://example.com/mcp"
        : "https://api.github.com");
  const binding =
    overrides.binding
    ?? (kind === "openapi"
      ? {
          specUrl: "https://api.github.com/openapi.json",
          defaultHeaders: null,
        }
      : kind === "graphql"
        ? {
            defaultHeaders: null,
          }
        : kind === "mcp"
          ? {
              transport: null,
              queryParams: null,
              headers: null,
            }
          : {});

  return {
    id: SourceIdSchema.make("src_runtime_recipe"),
    workspaceId: WorkspaceIdSchema.make("ws_runtime_recipe"),
    name: "GitHub",
    kind,
    endpoint,
    status: "connected",
    enabled: true,
    namespace: "github",
    bindingVersion: 1,
    binding,
    importAuthPolicy: "reuse_runtime",
    importAuth: { kind: "none" },
    auth: { kind: "none" },
    sourceHash: null,
    lastError: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
};

const makeOperation = (
  overrides: Partial<StoredSourceRecipeOperationRecord> = {},
): StoredSourceRecipeOperationRecord => ({
  id: "src_recipe_op_runtime",
  recipeRevisionId: SourceRecipeRevisionIdSchema.make("src_recipe_rev_runtime"),
  operationKey: "getRepo",
  transportKind: "http",
  toolId: "getRepo",
  title: "Get Repo",
  description: "Read a repository",
  operationKind: "read",
  searchText: "get repo github",
  inputSchemaJson: JSON.stringify({
    type: "object",
    additionalProperties: false,
  }),
  outputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      full_name: { type: "string" },
    },
  }),
  providerKind: "openapi",
  providerDataJson: JSON.stringify({
    kind: "openapi",
    toolId: "getRepo",
    rawToolId: "repos_getRepo",
    operationId: "repos.getRepo",
    group: "repos",
    leaf: "getRepo",
    tags: ["repos"],
    method: "get",
    path: "/repos/{owner}/{repo}",
    operationHash: "hash",
    invocation: {
      method: "get",
      pathTemplate: "/repos/{owner}/{repo}",
      parameters: [],
      requestBody: null,
    },
  }),
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const makeGraphqlOperation = (
  overrides: Partial<StoredSourceRecipeOperationRecord> = {},
): StoredSourceRecipeOperationRecord => ({
  id: "src_recipe_op_graphql_runtime",
  recipeRevisionId: SourceRecipeRevisionIdSchema.make("src_recipe_rev_runtime"),
  operationKey: "viewer",
  transportKind: "graphql",
  toolId: "viewer",
  title: "Viewer",
  description: "Query the current viewer",
  operationKind: "read",
  searchText: "viewer graphql query",
  inputSchemaJson: JSON.stringify({
    type: "object",
    additionalProperties: false,
  }),
  outputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      login: { type: "string" },
    },
  }),
  providerKind: "graphql",
  providerDataJson: JSON.stringify({
    kind: "graphql",
    toolKind: "field",
    toolId: "viewer",
    rawToolId: "viewer",
    group: "query",
    leaf: "viewer",
    fieldName: "viewer",
    operationType: "query",
    operationName: "viewer",
    operationDocument: "query Viewer { viewer { login } }",
    queryTypeName: "Query",
    mutationTypeName: null,
    subscriptionTypeName: null,
  }),
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const makeMcpOperation = (
  overrides: Partial<StoredSourceRecipeOperationRecord> = {},
): StoredSourceRecipeOperationRecord => ({
  id: "src_recipe_op_mcp_runtime",
  recipeRevisionId: SourceRecipeRevisionIdSchema.make("src_recipe_rev_runtime"),
  operationKey: "echo",
  transportKind: "mcp",
  toolId: "echo",
  title: "Echo",
  description: "Echo a value",
  operationKind: "unknown",
  searchText: "echo mcp",
  inputSchemaJson: null,
  outputSchemaJson: null,
  providerKind: "mcp",
  providerDataJson: JSON.stringify({
    kind: "mcp",
    toolId: "echo",
    toolName: "echo",
    description: "Echo a value",
  }),
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const seedWorkspace = async (input: {
  persistence: SqlControlPlanePersistence;
  workspaceId: ReturnType<typeof WorkspaceIdSchema.make>;
  organizationId: ReturnType<typeof OrganizationIdSchema.make>;
  accountId: ReturnType<typeof AccountIdSchema.make>;
}) => {
  const now = 1000;
  await Effect.runPromise(input.persistence.rows.organizations.insert({
    id: input.organizationId,
    slug: `org-${input.organizationId}`,
    name: `Org ${input.organizationId}`,
    status: "active",
    createdByAccountId: input.accountId,
    createdAt: now,
    updatedAt: now,
  }));
  await Effect.runPromise(input.persistence.rows.workspaces.insert({
    id: input.workspaceId,
    organizationId: input.organizationId,
    name: `Workspace ${input.workspaceId}`,
    createdByAccountId: input.accountId,
    createdAt: now,
    updatedAt: now,
  }));
};

describe("source-recipes-runtime", () => {
  describe("recipe tool helpers", () => {
    it("derives tool paths from explicit and implicit namespaces", () => {
      const source = makeSource();
      const operation = makeOperation();

      expect(recipeToolPath({
        source,
        operation,
      })).toBe("github.getRepo");
      expect(recipeToolPath({
        source: makeSource({
          namespace: null,
          name: "My GitHub",
        }),
        operation,
      })).toBe("my.github.getRepo");
      expect(recipeToolPath({
        source: makeSource({
          namespace: "",
        }),
        operation,
      })).toBe("getRepo");
    });

    it("derives search namespaces from path segments and graphql namespaces", () => {
      const openApiSource = makeSource();
      const graphqlSource = makeSource({
        kind: "graphql",
        namespace: "issues",
      });

      expect(recipeToolSearchNamespace({
        source: openApiSource,
        path: "github.getRepo",
        operation: makeOperation(),
      })).toBe("github.getRepo");
      expect(recipeToolSearchNamespace({
        source: openApiSource,
        path: "a.b.c",
        operation: makeOperation(),
      })).toBe("a.b");
      expect(recipeToolSearchNamespace({
        source: graphqlSource,
        path: "ignored.path",
        operation: makeGraphqlOperation(),
      })).toBe("issues");
    });

    it("computes interaction modes and descriptor fields correctly", () => {
      expect(recipeToolDescriptor({
        source: makeSource(),
        operation: makeOperation(),
        path: "github.getRepo",
        includeSchemas: true,
      }).interaction).toBe("auto");

      expect(recipeToolDescriptor({
        source: makeSource(),
        operation: makeOperation({
          operationKind: "delete",
        }),
        path: "github.deleteRepo",
        includeSchemas: true,
      }).interaction).toBe("required");

      expect(recipeToolDescriptor({
        source: makeSource({
          kind: "graphql",
        }),
        operation: makeGraphqlOperation(),
        path: "graphql.viewer",
        includeSchemas: true,
      }).interaction).toBe("auto");

      expect(recipeToolDescriptor({
        source: makeSource({
          kind: "graphql",
        }),
        operation: makeGraphqlOperation({
          operationKind: "write",
        }),
        path: "graphql.createIssue",
        includeSchemas: true,
      }).interaction).toBe("required");

      expect(recipeToolDescriptor({
        source: makeSource({
          kind: "mcp",
          binding: {
            transport: "streamable-http",
            queryParams: null,
            headers: null,
          },
        }),
        operation: makeMcpOperation(),
        path: "mcp.echo",
        includeSchemas: true,
      }).interaction).toBe("auto");

      const descriptor = recipeToolDescriptor({
        source: makeSource(),
        operation: makeOperation({
          description: null,
          title: "Fallback Title",
          providerDataJson: null,
        }),
        path: "github.getRepo",
        includeSchemas: false,
      });

      expect(descriptor.description).toBe("Fallback Title");
      expect(descriptor.inputSchemaJson).toBeUndefined();
      expect(descriptor.outputSchemaJson).toBeUndefined();
      expect(descriptor).not.toHaveProperty("providerDataJson");
    });

    it("expands recipes into lower-cased searchable tools and handles empty operation sets", () => {
      const recipe: LoadedSourceRecipe = {
        source: makeSource({
          name: "GITHUB API",
        }),
        sourceRecord: {
          id: SourceIdSchema.make("src_runtime_recipe"),
          workspaceId: WorkspaceIdSchema.make("ws_runtime_recipe"),
          recipeId: SourceRecipeIdSchema.make("src_recipe_runtime"),
          recipeRevisionId: SourceRecipeRevisionIdSchema.make("src_recipe_rev_runtime"),
          name: "GITHUB API",
          kind: "openapi",
          endpoint: "https://api.github.com",
          status: "connected",
          enabled: true,
          namespace: "github",
          importAuthPolicy: "reuse_runtime",
          bindingConfigJson: openApiBindingConfigJson("https://api.github.com/openapi.json"),
          sourceHash: null,
          lastError: null,
          createdAt: 1000,
          updatedAt: 1000,
        },
        revision: {
          id: SourceRecipeRevisionIdSchema.make("src_recipe_rev_runtime"),
          recipeId: SourceRecipeIdSchema.make("src_recipe_runtime"),
          revisionNumber: 1,
          sourceConfigJson: "{}",
          manifestJson: null,
          manifestHash: null,
          materializationHash: null,
          createdAt: 1000,
          updatedAt: 1000,
        },
        documents: [],
        schemaBundles: [],
        operations: [makeOperation({
          searchText: "",
        })],
        manifest: null,
      };

      const expanded = Effect.runSync(
        expandRecipeTools({
          recipes: [recipe],
          includeSchemas: false,
        }),
      );
      expect(expanded).toHaveLength(1);
      expect(expanded[0]?.searchText).toBe(
        "github.getrepo github.getrepo github api github.getrepo getrepo get repo read a repository repos_getrepo repos.getrepo get /repos/{owner}/{repo} repos getrepo repos",
      );

      expect(Effect.runSync(expandRecipeTools({
        recipes: [{
          ...recipe,
          operations: [],
        }],
        includeSchemas: false,
      }))).toEqual([]);
    });
  });

  describe("recipe loading", () => {
    it("loads multiple sources sharing the same recipe revision", async () => {
      const persistence = await makePersistence();
      try {
        const workspaceId = WorkspaceIdSchema.make("ws_shared_revision");
        const organizationId = OrganizationIdSchema.make("org_shared_revision");
        const accountId = AccountIdSchema.make("acc_shared_revision");
        const recipeId = SourceRecipeIdSchema.make("src_recipe_shared_revision");
        const recipeRevisionId = SourceRecipeRevisionIdSchema.make("src_recipe_rev_shared_revision");
        const openApiDocument = JSON.stringify({
          openapi: "3.0.3",
          info: {
            title: "GitHub",
            version: "1.0.0",
          },
          paths: {
            "/repos/{owner}/{repo}": {
              get: {
                operationId: "repos.getRepo",
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
                  },
                },
              },
            },
          },
        });
        const manifest = await Effect.runPromise(extractOpenApiManifest("GitHub", openApiDocument));
        const definition = compileOpenApiToolDefinitions(manifest)[0]!;
        const presentation = buildOpenApiToolPresentation({
          definition,
        });

        await seedWorkspace({
          persistence,
          workspaceId,
          organizationId,
          accountId,
        });
        await Effect.runPromise(persistence.rows.sourceRecipes.upsert({
          id: recipeId,
          kind: "http_api",
          adapterKey: "openapi",
          providerKey: "generic_http",
          name: "GitHub",
          summary: null,
          visibility: "workspace",
          latestRevisionId: recipeRevisionId,
          createdAt: 1000,
          updatedAt: 1000,
        }));
        await Effect.runPromise(persistence.rows.sourceRecipeRevisions.upsert({
          id: recipeRevisionId,
          recipeId,
          revisionNumber: 1,
          sourceConfigJson: JSON.stringify({
            kind: "openapi",
            endpoint: "https://api.github.com",
            specUrl: "https://api.github.com/openapi.json",
            defaultHeaders: null,
          }),
          manifestJson: JSON.stringify(manifest),
          manifestHash: manifest.sourceHash,
          materializationHash: manifest.sourceHash,
          createdAt: 1000,
          updatedAt: 1000,
        }));
        await Effect.runPromise(persistence.rows.sourceRecipeDocuments.replaceForRevision({
          recipeRevisionId,
          documents: [{
            id: "src_recipe_doc_shared_revision",
            recipeRevisionId,
            documentKind: "openapi",
            documentKey: "https://api.github.com/openapi.json",
            contentText: openApiDocument,
            contentHash: manifest.sourceHash,
            fetchedAt: 1000,
            createdAt: 1000,
            updatedAt: 1000,
          }],
        }));
        await Effect.runPromise(persistence.rows.sourceRecipeOperations.replaceForRevision({
          recipeRevisionId,
          operations: [makeOperation({
            id: "src_recipe_op_shared_revision",
            recipeRevisionId,
            operationKey: definition.toolId,
            toolId: definition.toolId,
            title: definition.name,
            description: definition.description,
            searchText: `${definition.toolId} ${definition.name}`.toLowerCase(),
            inputSchemaJson: presentation.inputSchemaJson ?? null,
            outputSchemaJson: presentation.outputSchemaJson ?? null,
            providerDataJson: presentation.providerDataJson,
          })],
        }));

        for (const [index, name] of ["GitHub One", "GitHub Two"].entries()) {
          await Effect.runPromise(persistence.rows.sources.insert({
            id: SourceIdSchema.make(`src_shared_revision_${index}`),
            workspaceId,
            recipeId,
            recipeRevisionId,
            name,
            kind: "openapi",
            endpoint: "https://api.github.com",
            status: "connected",
            enabled: true,
            namespace: "github",
            importAuthPolicy: "reuse_runtime",
            bindingConfigJson: openApiBindingConfigJson("https://api.github.com/openapi.json"),
            sourceHash: manifest.sourceHash,
            lastError: null,
            createdAt: 1000 + index,
            updatedAt: 1000 + index,
          }));
        }

        const recipes = await Effect.runPromise(loadWorkspaceSourceRecipes({
          rows: persistence.rows,
          workspaceId,
        }));

        expect(recipes).toHaveLength(2);
        expect(recipes[0]?.documents).toHaveLength(1);
        expect(recipes[0]?.operations).toHaveLength(1);
        expect(recipes[0]?.documents).toBe(recipes[1]?.documents);
        expect(recipes[0]?.operations).toBe(recipes[1]?.operations);
      } finally {
        await persistence.close();
      }
    });

    it("loads sources with empty recipe documents and operations", async () => {
      const persistence = await makePersistence();
      try {
        const workspaceId = WorkspaceIdSchema.make("ws_empty_recipe_rows");
        const organizationId = OrganizationIdSchema.make("org_empty_recipe_rows");
        const accountId = AccountIdSchema.make("acc_empty_recipe_rows");
        const sourceId = SourceIdSchema.make("src_empty_recipe_rows");
        const recipeId = SourceRecipeIdSchema.make("src_recipe_empty_recipe_rows");
        const recipeRevisionId = SourceRecipeRevisionIdSchema.make("src_recipe_rev_empty_recipe_rows");

        await seedWorkspace({
          persistence,
          workspaceId,
          organizationId,
          accountId,
        });
        await Effect.runPromise(persistence.rows.sourceRecipes.upsert({
          id: recipeId,
          kind: "http_api",
          adapterKey: "graphql",
          providerKey: "generic_graphql",
          name: "GraphQL Demo",
          summary: null,
          visibility: "workspace",
          latestRevisionId: recipeRevisionId,
          createdAt: 1000,
          updatedAt: 1000,
        }));
        await Effect.runPromise(persistence.rows.sourceRecipeRevisions.upsert({
          id: recipeRevisionId,
          recipeId,
          revisionNumber: 1,
          sourceConfigJson: JSON.stringify({
            kind: "graphql",
            endpoint: "https://example.com/graphql",
            defaultHeaders: null,
          }),
          manifestJson: null,
          manifestHash: null,
          materializationHash: null,
          createdAt: 1000,
          updatedAt: 1000,
        }));
        await Effect.runPromise(persistence.rows.sources.insert({
          id: sourceId,
          workspaceId,
          recipeId,
          recipeRevisionId,
          name: "GraphQL Demo",
          kind: "graphql",
          endpoint: "https://example.com/graphql",
          status: "connected",
          enabled: true,
          namespace: "graphql",
          importAuthPolicy: "reuse_runtime",
          bindingConfigJson: graphqlBindingConfigJson(),
          sourceHash: null,
          lastError: null,
          createdAt: 1000,
          updatedAt: 1000,
        }));

        const recipes = await Effect.runPromise(loadWorkspaceSourceRecipes({
          rows: persistence.rows,
          workspaceId,
        }));

        expect(recipes).toHaveLength(1);
        expect(recipes[0]?.documents).toEqual([]);
        expect(recipes[0]?.operations).toEqual([]);
        expect(recipes[0]?.manifest).toBeNull();
      } finally {
        await persistence.close();
      }
    });

    it("fails clearly when loading a missing source, missing revision, or invalid manifest", async () => {
      const persistence = await makePersistence();
      try {
        await expect(Effect.runPromise(loadSourceWithRecipe({
          rows: persistence.rows,
          workspaceId: WorkspaceIdSchema.make("ws_missing_source"),
          sourceId: SourceIdSchema.make("src_missing_source"),
        }))).rejects.toThrow("Source not found");

        const workspaceId = WorkspaceIdSchema.make("ws_bad_recipe_runtime");
        const organizationId = OrganizationIdSchema.make("org_bad_recipe_runtime");
        const accountId = AccountIdSchema.make("acc_bad_recipe_runtime");
        const sourceId = SourceIdSchema.make("src_bad_recipe_runtime");
        const recipeId = SourceRecipeIdSchema.make("src_recipe_bad_recipe_runtime");
        const recipeRevisionId = SourceRecipeRevisionIdSchema.make("src_recipe_rev_bad_recipe_runtime");

        await seedWorkspace({
          persistence,
          workspaceId,
          organizationId,
          accountId,
        });
        await Effect.runPromise(persistence.rows.sourceRecipes.upsert({
          id: recipeId,
          kind: "http_api",
          adapterKey: "openapi",
          providerKey: "generic_http",
          name: "Broken GitHub",
          summary: null,
          visibility: "workspace",
          latestRevisionId: recipeRevisionId,
          createdAt: 1000,
          updatedAt: 1000,
        }));
        await Effect.runPromise(persistence.rows.sources.insert({
          id: sourceId,
          workspaceId,
          recipeId,
          recipeRevisionId,
          name: "Broken GitHub",
          kind: "openapi",
          endpoint: "https://api.github.com",
          status: "connected",
          enabled: true,
          namespace: "github",
          importAuthPolicy: "reuse_runtime",
          bindingConfigJson: openApiBindingConfigJson("https://api.github.com/openapi.json"),
          sourceHash: null,
          lastError: null,
          createdAt: 1000,
          updatedAt: 1000,
        }));

        await expect(Effect.runPromise(loadSourceWithRecipe({
          rows: persistence.rows,
          workspaceId,
          sourceId,
        }))).rejects.toThrow("Recipe revision missing");

        await Effect.runPromise(persistence.rows.sourceRecipeRevisions.upsert({
          id: recipeRevisionId,
          recipeId,
          revisionNumber: 1,
          sourceConfigJson: JSON.stringify({
            kind: "openapi",
            endpoint: "https://api.github.com",
            specUrl: "https://api.github.com/openapi.json",
            defaultHeaders: null,
          }),
          manifestJson: "{bad-json",
          manifestHash: null,
          materializationHash: null,
          createdAt: 1000,
          updatedAt: 1000,
        }));

        await expect(Effect.runPromise(loadSourceWithRecipe({
          rows: persistence.rows,
          workspaceId,
          sourceId,
        }))).rejects.toThrow(`Invalid OpenAPI manifest for ${sourceId}`);
      } finally {
        await persistence.close();
      }
    });
  });
});
