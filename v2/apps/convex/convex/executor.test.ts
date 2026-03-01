import { describe, expect, it } from "@effect/vitest";
import { extractOpenApiManifest } from "@executor-v2/management-api";
import { convexTest } from "convex-test";
import * as Effect from "effect/Effect";

import { api, internal } from "./_generated/api";
import { executeRunImpl } from "./executor";
import schema from "./schema";

const runtimeInternal = internal as any;

const setup = () =>
  convexTest(schema, {
    "./http.ts": () => import("./http"),
    "./mcp.ts": () => import("./mcp"),
    "./executor.ts": () => import("./executor"),
    "./runtimeCallbacks.ts": () => import("./runtimeCallbacks"),
    "./source_tool_registry.ts": () => import("./source_tool_registry"),
    "./task_runs.ts": () => import("./task_runs"),
    "./control_plane/storage.ts": () => import("./control_plane/storage"),
    "./control_plane/credentials.ts": () => import("./control_plane/credentials"),
    "./control_plane/sources.ts": () => import("./control_plane/sources"),
    "./control_plane/tool_registry.ts": () => import("./control_plane/tool_registry"),
    "./control_plane/openapi_ingest.ts": () => import("./control_plane/openapi_ingest"),
    "./workflow.ts": () => import("./workflow"),
    "./controlPlane.ts": () => import("./controlPlane"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });

const ensureWorkspace = async (
  t: ReturnType<typeof setup>,
  workspaceId: string,
  organizationId: string,
): Promise<void> => {
  await t.mutation(api.controlPlane.upsertWorkspace, {
    payload: {
      id: workspaceId,
      organizationId,
      name: workspaceId,
    },
  });
};

describe("Convex executor and control-plane", () => {
  it.effect("executes code via executeRunImpl", () =>
    Effect.gen(function* () {
      const originalEnv = {
        runUrl: process.env.CLOUDFLARE_SANDBOX_RUN_URL,
        authToken: process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN,
        callbackUrl: process.env.CLOUDFLARE_SANDBOX_CALLBACK_URL,
      };
      const originalFetch = globalThis.fetch;

      try {
        process.env.CLOUDFLARE_SANDBOX_RUN_URL = "https://sandbox.local/run";
        process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN = "sandbox-token";
        process.env.CLOUDFLARE_SANDBOX_CALLBACK_URL = "https://convex.local/callback";

        globalThis.fetch = (async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url !== "https://sandbox.local/run") {
            throw new Error(`Unexpected URL: ${url}`);
          }

          expect(init?.method).toBe("POST");
          const headers = new Headers(init?.headers as HeadersInit | undefined);
          expect(headers.get("authorization")).toBe(
            "Bearer sandbox-token",
          );

          return new Response(
            JSON.stringify({
              status: "completed",
              result: 42,
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }) as unknown as typeof fetch;

        const result = yield* executeRunImpl({
          code: "return 6 * 7;",
        });

        expect(result.status).toBe("completed");
        expect(result.result).toBe(42);
      } finally {
        globalThis.fetch = originalFetch;

        if (originalEnv.runUrl === undefined) {
          delete process.env.CLOUDFLARE_SANDBOX_RUN_URL;
        } else {
          process.env.CLOUDFLARE_SANDBOX_RUN_URL = originalEnv.runUrl;
        }

        if (originalEnv.authToken === undefined) {
          delete process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN;
        } else {
          process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN = originalEnv.authToken;
        }

        if (originalEnv.callbackUrl === undefined) {
          delete process.env.CLOUDFLARE_SANDBOX_CALLBACK_URL;
        } else {
          process.env.CLOUDFLARE_SANDBOX_CALLBACK_URL = originalEnv.callbackUrl;
        }
      }
    }),
  );

  it.effect("upserts, lists, and removes sources", () =>
    Effect.gen(function* () {
      const t = setup();

      const added = (yield* Effect.tryPromise(() =>
        t.action(api.controlPlane.upsertSource as any, {
          workspaceId: "ws_1",
          payload: {
            id: "src_1",
            name: "Weather",
            kind: "openapi",
            endpoint: "https://example.com/openapi.json",
            enabled: true,
            configJson: "{}",
            status: "draft",
            sourceHash: null,
            lastError: null,
          },
        }),
      )) as {
        id: string;
        workspaceId: string;
        name: string;
      };

      yield* Effect.tryPromise(() => t.finishAllScheduledFunctions(() => {}));

      expect(added.id).toBe("src_1");
      expect(added.workspaceId).toBe("ws_1");
      expect(added.name).toBe("Weather");

      const listed = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listSources, {
          workspaceId: "ws_1",
        }),
      )) as Array<{
        id: string;
      }>;

      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe("src_1");

      const removed = (yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.removeSource, {
          workspaceId: "ws_1",
          sourceId: "src_1",
        }),
      )) as {
        removed: boolean;
      };

      expect(removed.removed).toBe(true);

      const listedAfterRemove = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listSources, {
          workspaceId: "ws_1",
        }),
      )) as Array<unknown>;

      expect(listedAfterRemove).toHaveLength(0);
    }),
  );

  it.effect("upserts, lists, and removes credentials, policies, and storage", () =>
    Effect.gen(function* () {
      const t = setup();

      yield* Effect.tryPromise(() => ensureWorkspace(t, "ws_1", "org_1"));

      const addedCredential = (yield* Effect.tryPromise(() =>
        t.action(api.controlPlane.upsertCredentialBinding, {
          workspaceId: "ws_1",
          payload: {
            id: "credential_binding_1",
            credentialId: "cred_1",
            scopeType: "workspace",
            sourceKey: "github",
            provider: "bearer",
            secretRef: "secret://github/token",
            accountId: null,
            additionalHeadersJson: null,
            boundAuthFingerprint: null,
          },
        }),
      )) as {
        id: string;
        workspaceId: string | null;
      };

      expect(addedCredential.id).toBe("credential_binding_1");
      expect(addedCredential.workspaceId).toBe("ws_1");

      const listedCredentials = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listCredentialBindings, {
          workspaceId: "ws_1",
        }),
      )) as Array<{
        id: string;
      }>;

      expect(listedCredentials).toHaveLength(1);
      expect(listedCredentials[0]?.id).toBe("credential_binding_1");

      const removedCredential = (yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.removeCredentialBinding, {
          workspaceId: "ws_1",
          credentialBindingId: "credential_binding_1",
        }),
      )) as {
        removed: boolean;
      };

      expect(removedCredential.removed).toBe(true);

      const listedCredentialsAfterRemove = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listCredentialBindings, {
          workspaceId: "ws_1",
        }),
      )) as Array<unknown>;

      expect(listedCredentialsAfterRemove).toHaveLength(0);

      const addedPolicy = (yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.upsertPolicy, {
          workspaceId: "ws_1",
          payload: {
            id: "pol_1",
            toolPathPattern: "github.repos.*",
            decision: "require_approval",
          },
        }),
      )) as {
        id: string;
        workspaceId: string;
      };

      expect(addedPolicy.id).toBe("pol_1");
      expect(addedPolicy.workspaceId).toBe("ws_1");

      const listedPolicies = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listPolicies, {
          workspaceId: "ws_1",
        }),
      )) as Array<{
        id: string;
      }>;

      expect(listedPolicies).toHaveLength(1);
      expect(listedPolicies[0]?.id).toBe("pol_1");

      const removedPolicy = (yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.removePolicy, {
          workspaceId: "ws_1",
          policyId: "pol_1",
        }),
      )) as {
        removed: boolean;
      };

      expect(removedPolicy.removed).toBe(true);

      const listedPoliciesAfterRemove = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listPolicies, {
          workspaceId: "ws_1",
        }),
      )) as Array<unknown>;

      expect(listedPoliciesAfterRemove).toHaveLength(0);

      const openedStorage = (yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.openStorageInstance, {
          workspaceId: "ws_1",
          payload: {
            scopeType: "workspace",
            durability: "ephemeral",
            provider: "agentfs-local",
            purpose: "test storage",
            ttlHours: 1,
            sessionId: "session_1",
          },
        }),
      )) as {
        id: string;
        status: string;
      };

      expect(openedStorage.status).toBe("active");

      const listedStorage = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listStorageInstances, {
          workspaceId: "ws_1",
        }),
      )) as Array<{
        id: string;
      }>;

      expect(listedStorage).toHaveLength(1);
      expect(listedStorage[0]?.id).toBe(openedStorage.id);

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.storage.upsertStorageFileEntry, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
          payload: {
            path: "/notes/today.txt",
            content: "hello convex storage",
          },
        }),
      );

      const listedDirectory = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listStorageDirectory, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
          payload: {
            path: "/",
          },
        }),
      )) as {
        path: string;
        entries: ReadonlyArray<{
          name: string;
          path: string;
          kind: "file" | "directory";
        }>;
      };

      expect(listedDirectory.path).toBe("/");
      expect(listedDirectory.entries).toHaveLength(1);
      expect(listedDirectory.entries[0]?.name).toBe("notes");
      expect(listedDirectory.entries[0]?.kind).toBe("directory");

      const listedNestedDirectory = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listStorageDirectory, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
          payload: {
            path: "/notes",
          },
        }),
      )) as {
        path: string;
        entries: ReadonlyArray<{
          name: string;
          path: string;
          kind: "file" | "directory";
        }>;
      };

      expect(listedNestedDirectory.path).toBe("/notes");
      expect(listedNestedDirectory.entries).toHaveLength(1);
      expect(listedNestedDirectory.entries[0]?.name).toBe("today.txt");
      expect(listedNestedDirectory.entries[0]?.kind).toBe("file");

      const readStorageFile = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.readStorageFile, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
          payload: {
            path: "/notes/today.txt",
            encoding: "utf8",
          },
        }),
      )) as {
        content: string;
      };

      expect(readStorageFile.content).toBe("hello convex storage");

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.storage.upsertStorageKvEntry, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
          payload: {
            key: "feature.enabled",
            valueJson: "true",
          },
        }),
      );

      const listedKv = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listStorageKv, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
          payload: {
            prefix: "feature.",
          },
        }),
      )) as {
        items: Array<{
          key: string;
          value: unknown;
        }>;
      };

      expect(listedKv.items).toHaveLength(1);
      expect(listedKv.items[0]?.key).toBe("feature.enabled");
      expect(listedKv.items[0]?.value).toBe(true);

      yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.queryStorageSql, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
          payload: {
            sql: "CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
          },
        }),
      );

      yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.queryStorageSql, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
          payload: {
            sql: "INSERT INTO kv_store (key, value) VALUES ('hello', 'world');",
          },
        }),
      );

      const queriedSql = (yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.queryStorageSql, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
          payload: {
            sql: "SELECT key, value FROM kv_store LIMIT 10;",
          },
        }),
      )) as {
        rowCount: number;
        columns: Array<string>;
        rows: Array<Record<string, unknown>>;
      };

      expect(queriedSql.rowCount).toBe(1);
      expect(queriedSql.columns).toEqual(["key", "value"]);
      expect(queriedSql.rows[0]).toEqual({ key: "hello", value: "world" });

      const closedStorage = (yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.closeStorageInstance, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
        }),
      )) as {
        id: string;
        status: string;
      };

      expect(closedStorage.id).toBe(openedStorage.id);
      expect(closedStorage.status).toBe("closed");

      const removedStorage = (yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.removeStorageInstance, {
          workspaceId: "ws_1",
          storageInstanceId: openedStorage.id,
        }),
      )) as {
        removed: boolean;
      };

      expect(removedStorage.removed).toBe(true);

      const listedStorageAfterRemove = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listStorageInstances, {
          workspaceId: "ws_1",
        }),
      )) as Array<unknown>;

      expect(listedStorageAfterRemove).toHaveLength(0);
    }),
  );

  it.effect("upserts and lists organizations/workspaces and tool views", () =>
    Effect.gen(function* () {
      const t = setup();

      const organization = (yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.upsertOrganization, {
          payload: {
            id: "org_1",
            slug: "acme",
            name: "Acme Inc",
            status: "active",
          },
        }),
      )) as {
        id: string;
        name: string;
      };

      expect(organization.id).toBe("org_1");
      expect(organization.name).toBe("Acme Inc");

      const organizations = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listOrganizations, {}),
      )) as Array<{
        id: string;
      }>;

      expect(organizations).toHaveLength(1);
      expect(organizations[0]?.id).toBe("org_1");

      const workspace = (yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.upsertWorkspace, {
          payload: {
            id: "ws_1",
            organizationId: "org_1",
            name: "Primary Workspace",
          },
        }),
      )) as {
        id: string;
        organizationId: string;
      };

      expect(workspace.id).toBe("ws_1");
      expect(workspace.organizationId).toBe("org_1");

      const workspaces = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listWorkspaces, {}),
      )) as Array<{
        id: string;
      }>;

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]?.id).toBe("ws_1");

      const nowForOpenApiSource = Date.now();
      yield* Effect.tryPromise(() =>
        t.run(async (ctx) => {
          await ctx.db.insert("sources", {
            id: "src_1",
            workspaceId: "ws_1",
            name: "Weather API",
            kind: "openapi",
            endpoint: "https://example.com/openapi.json",
            enabled: true,
            configJson: "{}",
            status: "draft",
            sourceHash: null,
            lastError: null,
            createdAt: nowForOpenApiSource,
            updatedAt: nowForOpenApiSource,
          });
        }),
      );

      const manifest = yield* extractOpenApiManifest("Weather API", {
        openapi: "3.0.0",
        info: {
          title: "Weather API",
          version: "1.0.0",
        },
        paths: {
          "/weather": {
            get: {
              operationId: "getWeather",
              responses: {
                "200": {
                  description: "ok",
                },
              },
            },
          },
        },
      });

      const now = Date.now();
      const openApiArtifactMeta = (yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.upsertArtifactMeta, {
          protocol: "openapi",
          contentHash: manifest.sourceHash,
          extractorVersion: "openapi_v2",
          toolCount: manifest.tools.length,
          refHintTableJson: manifest.refHintTable ? JSON.stringify(manifest.refHintTable) : null,
        }),
      )) as {
        artifactId: string;
        created: boolean;
      };

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.putArtifactToolsBatch, {
          artifactId: openApiArtifactMeta.artifactId,
          protocol: "openapi",
          insertOnly: true,
          tools: manifest.tools.map((tool) => ({
            toolId: tool.toolId,
            name: tool.name,
            description: tool.description,
            canonicalPath: `${tool.method.toUpperCase()} ${tool.path}`,
            operationHash: tool.operationHash,
            invocationJson: JSON.stringify(tool.invocation),
            inputSchemaJson: tool.typing?.inputSchemaJson ?? null,
            outputSchemaJson: tool.typing?.outputSchemaJson ?? null,
            metadataJson: JSON.stringify({
              method: tool.method,
              path: tool.path,
            }),
          })),
        }),
      );

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.bindSourceToArtifact, {
          workspaceId: "ws_1",
          sourceId: "src_1",
          artifactId: openApiArtifactMeta.artifactId,
        }),
      );

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.replaceWorkspaceSourceToolIndex, {
          workspaceId: "ws_1",
          sourceId: "src_1",
          sourceName: "Weather API",
          sourceKind: "openapi",
          artifactId: openApiArtifactMeta.artifactId,
          namespace: "weather_api_src_1",
          refHintTableJson: manifest.refHintTable ? JSON.stringify(manifest.refHintTable) : null,
          rows: manifest.tools.map((tool) => ({
            toolId: tool.toolId,
            protocol: "openapi",
            method: tool.method,
            path: `weather_api_src_1.${tool.toolId}`,
            name: tool.name,
            description: tool.description,
            searchText: `weather api ${tool.name.toLowerCase()} ${tool.path.toLowerCase()} ${tool.method.toLowerCase()}`,
            operationHash: tool.operationHash,
            approvalMode: "auto",
            status: "active",
          })),
        }),
      );

      const workspaceTools = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listWorkspaceTools, {
          workspaceId: "ws_1",
        }),
      )) as Array<{
        sourceId: string;
      }>;

      expect(workspaceTools).toHaveLength(1);
      expect(workspaceTools[0]?.sourceId).toBe("src_1");

      const sourceTools = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listSourceTools, {
          workspaceId: "ws_1",
          sourceId: "src_1",
        }),
      )) as Array<{
        sourceId: string;
      }>;

      expect(sourceTools).toHaveLength(1);
      expect(sourceTools[0]?.sourceId).toBe("src_1");

      const nowForGraphqlSource = Date.now();
      yield* Effect.tryPromise(() =>
        t.run(async (ctx) => {
          await ctx.db.insert("sources", {
            id: "src_graphql_1",
            workspaceId: "ws_1",
            name: "Linear API",
            kind: "graphql",
            endpoint: "https://api.linear.app/graphql",
            enabled: true,
            configJson: "{}",
            status: "draft",
            sourceHash: null,
            lastError: null,
            createdAt: nowForGraphqlSource,
            updatedAt: nowForGraphqlSource,
          });
        }),
      );

      const graphqlArtifactMeta = (yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.upsertArtifactMeta, {
          protocol: "graphql",
          contentHash: "graphql_schema_hash_1",
          extractorVersion: "graphql_v1",
          toolCount: 2,
          refHintTableJson: null,
        }),
      )) as {
        artifactId: string;
        created: boolean;
      };

      expect(graphqlArtifactMeta.created).toBe(true);

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.putArtifactToolsBatch, {
          artifactId: graphqlArtifactMeta.artifactId,
          protocol: "graphql",
          insertOnly: true,
          tools: [
            {
              toolId: "linear.graphql",
              name: "Linear GraphQL",
              description: "Run raw GraphQL queries against Linear",
              canonicalPath: "raw.graphql",
              operationHash: "raw_hash",
              invocationJson: "{}",
              metadataJson: JSON.stringify({
                operationType: "raw",
                fieldName: "graphql",
              }),
            },
            {
              toolId: "linear.query.viewer",
              name: "viewer",
              description: "Current viewer",
              canonicalPath: "query.viewer",
              operationHash: "viewer_hash",
              invocationJson: "{}",
              metadataJson: JSON.stringify({
                operationType: "query",
                fieldName: "viewer",
              }),
            },
          ],
        }),
      );

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.bindSourceToArtifact, {
          workspaceId: "ws_1",
          sourceId: "src_graphql_1",
          artifactId: graphqlArtifactMeta.artifactId,
        }),
      );

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.replaceWorkspaceSourceToolIndex, {
          workspaceId: "ws_1",
          sourceId: "src_graphql_1",
          sourceName: "Linear API",
          sourceKind: "graphql",
          artifactId: graphqlArtifactMeta.artifactId,
          namespace: "linear_api_phql_1",
          refHintTableJson: null,
          rows: [
            {
              toolId: "linear.graphql",
              protocol: "graphql",
              method: "post",
              path: "linear_api_phql_1.linear.graphql",
              name: "Linear GraphQL",
              description: "Run raw GraphQL queries against Linear",
              searchText: "linear api graphql linear.graphql",
              operationHash: "raw_hash",
              approvalMode: "auto",
              status: "active",
            },
            {
              toolId: "linear.query.viewer",
              protocol: "graphql",
              method: "post",
              path: "linear_api_phql_1.linear.query.viewer",
              name: "viewer",
              description: "Current viewer",
              searchText: "linear api graphql viewer linear.query.viewer",
              operationHash: "viewer_hash",
              approvalMode: "auto",
              status: "active",
            },
          ],
        }),
      );

      const graphqlSourceTools = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listSourceTools, {
          workspaceId: "ws_1",
          sourceId: "src_graphql_1",
        }),
      )) as Array<{
        sourceId: string;
        toolId: string;
        method: string;
      }>;

      expect(graphqlSourceTools).toHaveLength(2);
      expect(graphqlSourceTools[0]?.sourceId).toBe("src_graphql_1");
      expect(graphqlSourceTools[0]?.method).toBe("post");

      const workspaceToolsWithGraphql = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listWorkspaceTools, {
          workspaceId: "ws_1",
        }),
      )) as Array<{
        sourceId: string;
      }>;

      expect(workspaceToolsWithGraphql.some((tool) => tool.sourceId === "src_graphql_1")).toBe(
        true,
      );

      const nowForMcpSource = Date.now();

      yield* Effect.tryPromise(() =>
        t.run(async (ctx) => {
          await ctx.db.insert("sources", {
            id: "src_mcp_1",
            workspaceId: "ws_1",
            name: "Deepwiki",
            kind: "mcp",
            endpoint: "https://example.com/mcp",
            enabled: true,
            configJson: "{}",
            status: "draft",
            sourceHash: null,
            lastError: null,
            createdAt: nowForMcpSource,
            updatedAt: nowForMcpSource,
          });
        }),
      );

      const mcpArtifactMeta = (yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.upsertArtifactMeta, {
          protocol: "mcp",
          contentHash: "mcp_source_hash_1",
          extractorVersion: "mcp_v1",
          toolCount: 1,
          refHintTableJson: null,
        }),
      )) as {
        artifactId: string;
        created: boolean;
      };

      expect(mcpArtifactMeta.created).toBe(true);

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.putArtifactToolsBatch, {
          artifactId: mcpArtifactMeta.artifactId,
          protocol: "mcp",
          insertOnly: true,
          tools: [
            {
              toolId: "deepwiki.mcp.search_docs",
              name: "search_docs",
              description: "Search docs",
              canonicalPath: "search_docs",
              operationHash: "mcp_hash_1",
              invocationJson: "{}",
              metadataJson: JSON.stringify({
                toolName: "search_docs",
              }),
            },
          ],
        }),
      );

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.bindSourceToArtifact, {
          workspaceId: "ws_1",
          sourceId: "src_mcp_1",
          artifactId: mcpArtifactMeta.artifactId,
        }),
      );

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.control_plane.tool_registry.replaceWorkspaceSourceToolIndex, {
          workspaceId: "ws_1",
          sourceId: "src_mcp_1",
          sourceName: "Deepwiki",
          sourceKind: "mcp",
          artifactId: mcpArtifactMeta.artifactId,
          namespace: "deepwiki_mcp_1",
          refHintTableJson: null,
          rows: [
            {
              toolId: "deepwiki.mcp.search_docs",
              protocol: "mcp",
              method: "post",
              path: "deepwiki_mcp_1.deepwiki.mcp.search_docs",
              name: "search_docs",
              description: "Search docs",
              searchText: "deepwiki mcp search docs",
              operationHash: "mcp_hash_1",
              approvalMode: "auto",
              status: "active",
            },
          ],
        }),
      );

      const mcpSourceTools = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listSourceTools, {
          workspaceId: "ws_1",
          sourceId: "src_mcp_1",
        }),
      )) as Array<{
        sourceId: string;
        path: string;
      }>;

      expect(mcpSourceTools).toHaveLength(1);
      expect(mcpSourceTools[0]?.sourceId).toBe("src_mcp_1");
      expect(mcpSourceTools[0]?.path).toContain("deepwiki.mcp.search_docs");

      const workspaceToolsWithMcp = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listWorkspaceTools, {
          workspaceId: "ws_1",
        }),
      )) as Array<{
        sourceId: string;
      }>;

      expect(workspaceToolsWithMcp.some((tool) => tool.sourceId === "src_mcp_1")).toBe(true);

      const sourceToolsFromWrongWorkspace = (yield* Effect.tryPromise(() =>
        t.query(api.controlPlane.listSourceTools, {
          workspaceId: "ws_2",
          sourceId: "src_1",
        }),
      )) as Array<unknown>;

      expect(sourceToolsFromWrongWorkspace).toHaveLength(0);
    }),
  );

  it.effect("marks graphql sources auth_required when introspection is unauthorized", () =>
    Effect.gen(function* () {
      const t = setup();
      const originalFetch = globalThis.fetch;

      yield* Effect.tryPromise(() => ensureWorkspace(t, "ws_auth", "org_auth"));

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            errors: [
              {
                message: "Unauthorized",
              },
            ],
          }),
          {
            status: 401,
            headers: {
              "content-type": "application/json",
            },
          },
        )) as unknown as typeof fetch;

      try {
        const now = Date.now();

        yield* Effect.tryPromise(() =>
          t.run(async (ctx) => {
            await ctx.db.insert("sources", {
              id: "src_graphql_auth_1",
              workspaceId: "ws_auth",
              name: "Linear API",
              kind: "graphql",
              endpoint: "https://api.linear.app/graphql",
              enabled: true,
              configJson: "{}",
              status: "draft",
              sourceHash: null,
              lastError: null,
              createdAt: now,
              updatedAt: now,
            });
          }),
        );

        yield* Effect.tryPromise(() =>
          t.action(runtimeInternal.control_plane.openapi_ingest.ingestSourceArtifact, {
            workspaceId: "ws_auth",
            sourceId: "src_graphql_auth_1",
          }),
        );

        const sources = (yield* Effect.tryPromise(() =>
          t.query(api.controlPlane.listSources, {
            workspaceId: "ws_auth",
          }),
        )) as Array<{
          status: string;
          lastError: string | null;
        }>;

        expect(sources).toHaveLength(1);
        expect(sources[0]?.status).toBe("auth_required");
        expect(sources[0]?.lastError?.toLowerCase()).toContain("unauthor");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );

  it.effect("uses credential bindings when ingesting graphql sources", () =>
    Effect.gen(function* () {
      const t = setup();
      const originalFetch = globalThis.fetch;

      yield* Effect.tryPromise(() => ensureWorkspace(t, "ws_cred", "org_cred"));

      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const authHeader = new Headers(init?.headers).get("authorization");
        if (authHeader !== "Bearer linear_token") {
          return new Response(
            JSON.stringify({
              errors: [
                {
                  message: "Unauthorized",
                },
              ],
            }),
            {
              status: 401,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        const bodyText = typeof init?.body === "string" ? init.body : "{}";
        const payload = JSON.parse(bodyText) as {
          query?: string;
          variables?: {
            name?: string;
          };
        };

        if (payload.query?.includes("SchemaRoots")) {
          return new Response(
            JSON.stringify({
              data: {
                __schema: {
                  queryType: { name: "Query" },
                  mutationType: null,
                },
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (payload.query?.includes("RootFields") && payload.variables?.name === "Query") {
          return new Response(
            JSON.stringify({
              data: {
                __type: {
                  name: "Query",
                  fields: [
                    {
                      name: "viewer",
                      description: "Current viewer",
                      args: [],
                    },
                  ],
                },
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            data: {
              __type: {
                name: payload.variables?.name ?? "Unknown",
                fields: [],
              },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }) as unknown as typeof fetch;

      try {
        const now = Date.now();

        yield* Effect.tryPromise(() =>
          t.action(api.controlPlane.upsertCredentialBinding, {
            workspaceId: "ws_cred",
            payload: {
              id: "credential_binding_linear",
              credentialId: "cred_linear",
              scopeType: "workspace",
              sourceKey: "source:src_graphql_cred_1",
              provider: "bearer",
              secretRef: "linear_token",
              accountId: null,
              additionalHeadersJson: null,
              boundAuthFingerprint: null,
            },
          }),
        );

        yield* Effect.tryPromise(() =>
          t.run(async (ctx) => {
            await ctx.db.insert("sources", {
              id: "src_graphql_cred_1",
              workspaceId: "ws_cred",
              name: "Linear API",
              kind: "graphql",
              endpoint: "https://api.linear.app/graphql",
              enabled: true,
              configJson: "{}",
              status: "draft",
              sourceHash: null,
              lastError: null,
              createdAt: now,
              updatedAt: now,
            });
          }),
        );

        yield* Effect.tryPromise(() =>
          t.action(runtimeInternal.control_plane.openapi_ingest.ingestSourceArtifact, {
            workspaceId: "ws_cred",
            sourceId: "src_graphql_cred_1",
          }),
        );

        const sources = (yield* Effect.tryPromise(() =>
          t.query(api.controlPlane.listSources, {
            workspaceId: "ws_cred",
          }),
        )) as Array<{
          status: string;
          sourceHash: string | null;
        }>;

        expect(sources).toHaveLength(1);
        expect(sources[0]?.status).toBe("connected");
        expect(sources[0]?.sourceHash).toBeTypeOf("string");

        const sourceTools = (yield* Effect.tryPromise(() =>
          t.query(api.controlPlane.listSourceTools, {
            workspaceId: "ws_cred",
            sourceId: "src_graphql_cred_1",
          }),
        )) as Array<{
          toolId: string;
        }>;

        expect(sourceTools.length).toBeGreaterThan(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );

  it.effect("ingests mcp sources with credential headers", () =>
    Effect.gen(function* () {
      const t = setup();
      const originalFetch = globalThis.fetch;

      yield* Effect.tryPromise(() =>
        ensureWorkspace(t, "ws_mcp_ingest", "org_mcp_ingest")
      );

      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const authHeader = new Headers(init?.headers).get("authorization");
        if (authHeader !== "Bearer mcp_token") {
          return new Response(
            JSON.stringify({
              error: {
                code: 401,
                message: "Unauthorized",
              },
            }),
            {
              status: 401,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        const bodyText = typeof init?.body === "string" ? init.body : "{}";
        const payload = JSON.parse(bodyText) as {
          id?: string | number;
          method?: string;
        };

        if (payload.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: {
                  tools: {},
                },
                serverInfo: {
                  name: "fake-mcp",
                  version: "0.1.0",
                },
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (payload.method === "notifications/initialized") {
          return new Response(null, {
            status: 204,
          });
        }

        if (payload.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                tools: [
                  {
                    name: "search_docs",
                    description: "Search docs",
                    inputSchema: {
                      type: "object",
                      properties: {},
                    },
                    outputSchema: {
                      type: "object",
                      properties: {
                        results: {
                          type: "array",
                        },
                      },
                    },
                  },
                ],
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            error: {
              code: -32601,
              message: "Method not found",
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }) as unknown as typeof fetch;

      try {
        const now = Date.now();

        yield* Effect.tryPromise(() =>
          t.action(api.controlPlane.upsertCredentialBinding, {
            workspaceId: "ws_mcp_ingest",
            payload: {
              id: "credential_binding_mcp",
              credentialId: "cred_mcp",
              scopeType: "workspace",
              sourceKey: "source:src_mcp_ingest_1",
              provider: "bearer",
              secretRef: "mcp_token",
              accountId: null,
              additionalHeadersJson: null,
              boundAuthFingerprint: null,
            },
          }),
        );

        yield* Effect.tryPromise(() =>
          t.run(async (ctx) => {
            await ctx.db.insert("sources", {
              id: "src_mcp_ingest_1",
              workspaceId: "ws_mcp_ingest",
              name: "Deepwiki",
              kind: "mcp",
              endpoint: "https://example.com/mcp",
              enabled: true,
              configJson: "{}",
              status: "draft",
              sourceHash: null,
              lastError: null,
              createdAt: now,
              updatedAt: now,
            });
          }),
        );

        yield* Effect.tryPromise(() =>
          t.action(runtimeInternal.control_plane.openapi_ingest.ingestSourceArtifact, {
            workspaceId: "ws_mcp_ingest",
            sourceId: "src_mcp_ingest_1",
          }),
        );

        const sources = (yield* Effect.tryPromise(() =>
          t.query(api.controlPlane.listSources, {
            workspaceId: "ws_mcp_ingest",
          }),
        )) as Array<{
          status: string;
          sourceHash: string | null;
        }>;

        expect(sources).toHaveLength(1);
        expect(sources[0]?.status).toBe("connected");
        expect(sources[0]?.sourceHash).toBeTypeOf("string");

        const sourceTools = (yield* Effect.tryPromise(() =>
          t.query(api.controlPlane.listSourceTools, {
            workspaceId: "ws_mcp_ingest",
            sourceId: "src_mcp_ingest_1",
          }),
        )) as Array<{
          sourceId: string;
          path: string;
        }>;

        expect(sourceTools).toHaveLength(1);
        expect(sourceTools[0]?.sourceId).toBe("src_mcp_ingest_1");
        expect(sourceTools[0]?.path).toContain("deepwiki.mcp.search_docs");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );

  it.effect("persists approval state for runtime tool calls", () =>
    Effect.gen(function* () {
      const t = setup();

      const missingRunDecision = (yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.source_tool_registry.evaluateToolApproval, {
          workspaceId: "ws_1",
          runId: "run_approval_1",
          callId: "call_approval_1",
          toolPath: "github.repos.delete",
          inputPreviewJson: "{}",
          defaultMode: "auto",
          requireApprovals: true,
          retryAfterMs: 333,
        }),
      )) as {
        kind: "approved" | "pending" | "denied";
        error?: string;
      };

      expect(missingRunDecision.kind).toBe("denied");
      expect(missingRunDecision.error).toContain("Unknown run for approval request");

      yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.task_runs.startTaskRun, {
          workspaceId: "ws_1",
          runId: "run_approval_1",
        }),
      );

      // First evaluation writes a pending approval row when this runId/callId is unseen.
      const firstDecision = (yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.source_tool_registry.evaluateToolApproval, {
          workspaceId: "ws_1",
          runId: "run_approval_1",
          callId: "call_approval_1",
          toolPath: "github.repos.delete",
          inputPreviewJson: "{}",
          defaultMode: "auto",
          requireApprovals: true,
          retryAfterMs: 333,
        }),
      )) as {
        kind: "approved" | "pending" | "denied";
        approvalId?: string;
        retryAfterMs?: number;
      };

      expect(firstDecision.kind).toBe("pending");
      expect(firstDecision.retryAfterMs).toBe(333);
      expect(firstDecision.approvalId).toBeTypeOf("string");

      const secondDecision = (yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.source_tool_registry.evaluateToolApproval, {
          workspaceId: "ws_1",
          runId: "run_approval_1",
          callId: "call_approval_1",
          toolPath: "github.repos.delete",
          inputPreviewJson: "{}",
          defaultMode: "auto",
          requireApprovals: true,
          retryAfterMs: 333,
        }),
      )) as {
        kind: "approved" | "pending" | "denied";
        approvalId?: string;
      };

      expect(secondDecision.kind).toBe("pending");
      expect(secondDecision.approvalId).toBe(firstDecision.approvalId);

      const approvalId = firstDecision.approvalId;
      if (!approvalId) {
        throw new Error("expected approval id");
      }

      yield* Effect.tryPromise(() =>
        t.mutation(api.controlPlane.resolveApproval, {
          workspaceId: "ws_1",
          approvalId,
          payload: {
            status: "approved",
            reason: "approved by test",
          },
        }),
      );

      const resolvedDecision = (yield* Effect.tryPromise(() =>
        t.mutation(runtimeInternal.source_tool_registry.evaluateToolApproval, {
          workspaceId: "ws_1",
          runId: "run_approval_1",
          callId: "call_approval_1",
          toolPath: "github.repos.delete",
          inputPreviewJson: "{}",
          defaultMode: "auto",
          requireApprovals: true,
          retryAfterMs: 333,
        }),
      )) as {
        kind: "approved" | "pending" | "denied";
      };

      expect(resolvedDecision).toEqual({
        kind: "approved",
      });
    }),
  );
});
