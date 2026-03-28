import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  createScopeSourceCatalog,
} from "./source-catalog";

const makeLoadedCatalog = (input: {
  sourceId: string;
  toolPaths: ReadonlyArray<string>;
  enabled?: boolean;
  status?: "connected" | "error";
}) => ({
  source: {
    id: input.sourceId,
    scopeId: "ws_test",
    name: input.sourceId,
    kind: "openapi",
    endpoint: `https://example.test/${input.sourceId}`,
    status: input.status ?? "connected",
    enabled: input.enabled ?? true,
    namespace: null,
    bindingVersion: 1,
    binding: {},
    importAuthPolicy: "reuse_runtime",
    importAuth: {
      kind: "none",
    },
    auth: {
      kind: "none",
    },
    sourceHash: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  },
  projected: {
    toolDescriptors: Object.fromEntries(
      input.toolPaths.map((path, index) => [
        `cap_${index}`,
        {
          toolPath: path.split("."),
        },
      ]),
    ),
  },
}) as any;

const noopScopeConfigStore = {
  load: () => Effect.die("unexpected config load"),
  writeProject: () => Effect.void,
  resolveRelativePath: (path: string) => Effect.succeed(path),
} as any;

const noopScopeStateStore = {
  load: () => Effect.die("unexpected scope state load"),
  write: () => Effect.void,
} as any;

const noopSourceArtifactStore = {
  build: () => Effect.die("unexpected source artifact build"),
  read: () => Effect.die("unexpected source artifact read"),
  write: () => Effect.void,
  remove: () => Effect.void,
} as any;

describe("scope source catalog", () => {
  it.effect("lists namespaces from projected tool paths without loading the tool index", () =>
    Effect.gen(function* () {
      const catalog = createScopeSourceCatalog({
        scopeId: "ws_test" as any,
        actorScopeId: "acc_test" as any,
        sourceCatalogStore: {
          loadWorkspaceSourceCatalogs: () => Effect.succeed([
            makeLoadedCatalog({
              sourceId: "github",
              toolPaths: [
                "github.repos.get",
                "github.repos.list",
                "github.issues.get",
              ],
            }),
            makeLoadedCatalog({
              sourceId: "linear",
              toolPaths: [
                "linear.issue.create",
              ],
            }),
            makeLoadedCatalog({
              sourceId: "disabled",
              toolPaths: [
                "disabled.admin.delete",
              ],
              enabled: false,
            }),
          ]),
          loadWorkspaceSourceCatalogToolIndex: () => Effect.die("unexpected tool index load"),
          loadWorkspaceSourceCatalogToolByPath: () => Effect.die("unexpected tool lookup"),
        } as any,
        scopeConfigStore: noopScopeConfigStore,
        scopeStateStore: noopScopeStateStore,
        sourceArtifactStore: noopSourceArtifactStore,
        runtimeLocalScope: null,
      });

      const namespaces = yield* catalog.listNamespaces({ limit: 10 });

      expect(namespaces).toEqual([
        {
          namespace: "github.issues",
          toolCount: 1,
        },
        {
          namespace: "github.repos",
          toolCount: 2,
        },
        {
          namespace: "linear.issue",
          toolCount: 1,
        },
      ]);
    }));

  it.effect("reuses the lean shared catalog for repeated search, list, and no-schema lookup calls", () =>
    Effect.gen(function* () {
      const loadWorkspaceSourceCatalogToolIndexCalls: Array<undefined> = [];

      const catalog = createScopeSourceCatalog({
        scopeId: "ws_test" as any,
        actorScopeId: "acc_test" as any,
        sourceCatalogStore: {
          loadWorkspaceSourceCatalogs: () => Effect.die("unexpected catalog load"),
          loadWorkspaceSourceCatalogToolIndex: () => {
            loadWorkspaceSourceCatalogToolIndexCalls.push(undefined);

            return Effect.succeed([{
              path: "github.issues.list",
              searchNamespace: "github.issues",
              searchText: "github issues list repository issues",
              source: {
                enabled: true,
                status: "connected",
              },
              sourceRecord: {},
              capabilityId: "cap_1",
              executableId: "exec_1",
              capability: {
                surface: {
                  title: "List Repository Issues",
                  summary: "List issues for a repository",
                },
              },
              executable: {
                display: {
                  leaf: "list",
                  operationId: "listRepositoryIssues",
                  pathTemplate: "/repos/{owner}/{repo}/issues",
                },
              },
              descriptor: {
                path: "github.issues.list",
                sourceKey: "github",
                description: "List issues for a repository",
                interaction: "auto",
              },
              projectedCatalog: {},
            }] as any);
          },
          loadWorkspaceSourceCatalogToolByPath: () => Effect.die("unexpected tool lookup"),
        } as any,
        scopeConfigStore: noopScopeConfigStore,
        scopeStateStore: noopScopeStateStore,
        sourceArtifactStore: noopSourceArtifactStore,
        runtimeLocalScope: null,
      });

      const hits = yield* catalog.searchTools({
        query: "GitHub list repository issues",
        limit: 20,
      });
      const first = yield* catalog.getToolByPath({
        path: "github.issues.list" as any,
        includeSchemas: false,
      });
      const second = yield* catalog.getToolByPath({
        path: "github.issues.list" as any,
        includeSchemas: false,
      });
      const listed = yield* catalog.listTools({
        query: "GitHub list repository issues",
        limit: 20,
        includeSchemas: false,
      });
      const listedWithSchemas = yield* catalog.listTools({
        query: "GitHub list repository issues",
        limit: 20,
        includeSchemas: true,
      });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.path).toBe("github.issues.list");
      expect(hits[0]?.score).toBeGreaterThan(0);
      expect(first?.contract?.inputTypePreview).toBeUndefined();
      expect(second?.contract?.outputTypePreview).toBeUndefined();
      expect(listed).toHaveLength(1);
      expect(listedWithSchemas).toHaveLength(1);
      expect(listedWithSchemas[0]?.contract?.inputSchema).toBeUndefined();
      expect(loadWorkspaceSourceCatalogToolIndexCalls).toHaveLength(1);
    }));

  it.effect("loads schemaful tool descriptions through direct tool lookup instead of a shared schema catalog", () =>
    Effect.gen(function* () {
      const loadWorkspaceSourceCatalogToolIndexCalls: Array<undefined> = [];
      const loadWorkspaceSourceCatalogToolByPathCalls: Array<{
        path: string;
        includeSchemas: boolean;
      }> = [];

      const catalog = createScopeSourceCatalog({
        scopeId: "ws_test" as any,
        actorScopeId: "acc_test" as any,
        sourceCatalogStore: {
          loadWorkspaceSourceCatalogs: () => Effect.die("unexpected catalog load"),
          loadWorkspaceSourceCatalogToolIndex: () => {
            loadWorkspaceSourceCatalogToolIndexCalls.push(undefined);

            return Effect.succeed([{
              path: "github.issues.list",
              searchNamespace: "github.issues",
              searchText: "github issues list repository issues",
              source: {
                enabled: true,
                status: "connected",
              },
              sourceRecord: {},
              capabilityId: "cap_1",
              executableId: "exec_1",
              capability: {
                surface: {
                  title: "List Repository Issues",
                },
              },
              executable: {
                display: {
                  leaf: "list",
                },
              },
              descriptor: {
                path: "github.issues.list",
                sourceKey: "github",
                description: "List issues for a repository",
                interaction: "auto",
              },
              projectedCatalog: {},
            }] as any);
          },
          loadWorkspaceSourceCatalogToolByPath: (input: {
            path: string;
            includeSchemas: boolean;
          }) => {
            loadWorkspaceSourceCatalogToolByPathCalls.push(input);
            return Effect.succeed({
              path: "github.issues.list",
              searchNamespace: "github.issues",
              searchText: "github issues list repository issues",
              source: {
                enabled: true,
                status: "connected",
              },
              sourceRecord: {},
              capabilityId: "cap_1",
              executableId: "exec_1",
              capability: {
                surface: {
                  title: "List Repository Issues",
                },
              },
              executable: {
                display: {
                  leaf: "list",
                },
              },
              descriptor: {
                path: "github.issues.list",
                sourceKey: "github",
                description: "List issues for a repository",
                interaction: "auto",
                contract: {
                  inputSchema: {
                    type: "object",
                  },
                },
              },
              projectedCatalog: {},
            } as any);
          },
        } as any,
        scopeConfigStore: noopScopeConfigStore,
        scopeStateStore: noopScopeStateStore,
        sourceArtifactStore: noopSourceArtifactStore,
        runtimeLocalScope: null,
      });

      const tool = yield* catalog.getToolByPath({
        path: "github.issues.list" as any,
        includeSchemas: true,
      });

      expect(tool?.path).toBe("github.issues.list");
      expect(tool?.contract?.inputSchema).toEqual({
        type: "object",
      });
      expect(loadWorkspaceSourceCatalogToolIndexCalls).toHaveLength(0);
      expect(loadWorkspaceSourceCatalogToolByPathCalls).toEqual([{
        scopeId: "ws_test",
        path: "github.issues.list",
        actorScopeId: "acc_test",
        includeSchemas: true,
      }]);
    }));
});
