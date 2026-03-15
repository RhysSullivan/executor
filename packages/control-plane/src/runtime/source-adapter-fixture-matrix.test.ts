import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import {
  buildOpenApiToolPresentation,
  compileOpenApiToolDefinitions,
  extractOpenApiManifest,
  type OpenApiJsonObject,
} from "@executor/codemode-openapi";
import {
  buildGoogleDiscoveryToolPresentation,
  compileGoogleDiscoveryToolDefinitions,
  extractGoogleDiscoveryManifest,
} from "@executor/codemode-google-discovery";
import { describe, expect, it } from "@effect/vitest";

import type {
  Source,
  StoredSourceCatalogRevisionRecord,
  StoredSourceRecord,
} from "#schema";
import {
  SourceCatalogIdSchema,
  SourceCatalogRevisionIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
} from "#schema";
import * as Effect from "effect/Effect";

import { projectCatalogForAgentSdk } from "../ir/catalog";
import type { CatalogSnapshotV1 } from "../ir/model";
import { createCatalogTypeProjector, projectedCatalogTypeRoots } from "./catalog-typescript";
import {
  buildGraphqlToolPresentation,
  compileGraphqlToolDefinitions,
  extractGraphqlManifest,
} from "./graphql-tools";
import {
  expandCatalogToolByPath,
  type LoadedSourceCatalog,
} from "./source-catalog-runtime";
import { invokeIrTool } from "./ir-execution";
import {
  createGoogleDiscoveryCatalogSnapshot,
  createGraphqlCatalogSnapshot,
  createOpenApiCatalogSnapshot,
} from "./source-catalog-snapshot";

const FIXTURE_WORKSPACE_ID = WorkspaceIdSchema.make("ws_source_fixture_matrix");

const readFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const makeSource = (input: {
  id: string;
  name: string;
  kind: Source["kind"];
  endpoint: string;
  namespace: string;
  binding: Source["binding"];
}): Source => ({
  id: SourceIdSchema.make(input.id),
  workspaceId: FIXTURE_WORKSPACE_ID,
  name: input.name,
  kind: input.kind,
  endpoint: input.endpoint,
  status: "connected",
  enabled: true,
  namespace: input.namespace,
  bindingVersion: 1,
  binding: input.binding,
  importAuthPolicy: "none",
  importAuth: { kind: "none" },
  auth: { kind: "none" },
  sourceHash: `hash_${input.id}`,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});

const makeLoadedCatalog = (input: {
  source: Source;
  snapshot: CatalogSnapshotV1;
}): LoadedSourceCatalog => {
  const catalogId = SourceCatalogIdSchema.make(`catalog_${input.source.id}`);
  const revisionId = SourceCatalogRevisionIdSchema.make(
    `catalog_revision_${input.source.id}`,
  );
  const sourceRecord = {
    id: input.source.id,
    workspaceId: input.source.workspaceId,
    catalogId,
    catalogRevisionId: revisionId,
    name: input.source.name,
    kind: input.source.kind,
    endpoint: input.source.endpoint,
    status: input.source.status,
    enabled: input.source.enabled,
    namespace: input.source.namespace,
    importAuthPolicy: input.source.importAuthPolicy,
    bindingConfigJson: JSON.stringify(input.source.binding),
    sourceHash: input.source.sourceHash,
    lastError: input.source.lastError,
    createdAt: input.source.createdAt,
    updatedAt: input.source.updatedAt,
  } satisfies StoredSourceRecord;
  const revision = {
    id: revisionId,
    catalogId,
    revisionNumber: 1,
    sourceConfigJson: JSON.stringify({
      kind: input.source.kind,
      endpoint: input.source.endpoint,
      binding: input.source.binding,
    }),
    importMetadataJson: JSON.stringify(input.snapshot.import),
    importMetadataHash: "hash_import",
    snapshotHash: "hash_snapshot",
    createdAt: 1,
    updatedAt: 1,
  } satisfies StoredSourceCatalogRevisionRecord;
  const projected = projectCatalogForAgentSdk({
    catalog: input.snapshot.catalog,
  });

  return {
    source: input.source,
    sourceRecord,
    revision,
    snapshot: input.snapshot,
    catalog: input.snapshot.catalog,
    projected,
    typeProjector: createCatalogTypeProjector({
      catalog: projected.catalog,
      roots: projectedCatalogTypeRoots(projected),
    }),
    importMetadata: input.snapshot.import,
  };
};

const unresolvedDiagnosticsForPrefix = (
  snapshot: CatalogSnapshotV1,
  prefix: string,
) =>
  Object.values(snapshot.catalog.diagnostics).filter(
    (diagnostic) =>
      diagnostic.code === "unresolved_ref"
      && diagnostic.provenance.some((entry) =>
        entry.pointer?.startsWith(prefix),
      ),
  );

const openApiSnapshotFromFixture = (input: {
  source: Source;
  specText: string;
  documentKey: string;
}) =>
  Effect.gen(function* () {
    const spec = JSON.parse(input.specText) as OpenApiJsonObject;
    const manifest = yield* extractOpenApiManifest(input.source.name, spec);
    const definitions = compileOpenApiToolDefinitions(manifest);

    const snapshot = createOpenApiCatalogSnapshot({
      source: input.source,
      documents: [{
        documentKind: "openapi",
        documentKey: input.documentKey,
        contentText: input.specText,
        fetchedAt: 1,
      }],
      operations: definitions.map((definition) => {
        const presentation = buildOpenApiToolPresentation({
          definition,
          refHintTable: manifest.refHintTable,
        });
        const method = definition.method.toUpperCase();

        return {
          toolId: definition.toolId,
          title: definition.name,
          description: definition.description,
          effect:
            method === "GET" || method === "HEAD"
              ? "read"
              : method === "DELETE"
                ? "delete"
                : "write",
          inputSchema: presentation.inputSchema,
          outputSchema: presentation.outputSchema,
          providerData: presentation.providerData,
        };
      }),
    });

    return {
      manifest,
      snapshot,
    };
  });

const googleDiscoverySnapshotFromFixture = (input: {
  source: Source;
  documentText: string;
  documentKey: string;
}) =>
  Effect.gen(function* () {
    const manifest = yield* extractGoogleDiscoveryManifest(
      input.source.name,
      input.documentText,
    );
    const definitions = compileGoogleDiscoveryToolDefinitions(manifest);

    const snapshot = createGoogleDiscoveryCatalogSnapshot({
      source: input.source,
      documents: [{
        documentKind: "google_discovery",
        documentKey: input.documentKey,
        contentText: input.documentText,
        fetchedAt: 1,
      }],
      operations: definitions.map((definition) => {
        const presentation = buildGoogleDiscoveryToolPresentation({
          manifest,
          definition,
        });

        return {
          toolId: definition.toolId,
          title: definition.name,
          description: definition.description,
          effect:
            definition.method === "get" || definition.method === "head"
              ? "read"
              : definition.method === "delete"
                ? "delete"
                : "write",
          inputSchema: presentation.inputSchema,
          outputSchema: presentation.outputSchema,
          providerData: presentation.providerData,
        };
      }),
    });

    return {
      manifest,
      snapshot,
    };
  });

const graphqlSnapshotFromFixture = (input: {
  source: Source;
  documentText: string;
}) =>
  Effect.gen(function* () {
    const manifest = yield* extractGraphqlManifest(
      input.source.name,
      input.documentText,
    );
    const definitions = compileGraphqlToolDefinitions(manifest);

    const snapshot = createGraphqlCatalogSnapshot({
      source: input.source,
      documents: [{
        documentKind: "graphql_introspection",
        documentKey: input.source.endpoint,
        contentText: input.documentText,
        fetchedAt: 1,
      }],
      operations: definitions.map((definition) => {
        const presentation = buildGraphqlToolPresentation({
          manifest,
          definition,
        });

        return {
          toolId: definition.toolId,
          title: definition.name,
          description: definition.description,
          effect: definition.operationType === "query" ? "read" : "write",
          inputSchema: presentation.inputSchema,
          outputSchema: presentation.outputSchema,
          providerData: presentation.providerData,
        };
      }),
    });

    return {
      manifest,
      snapshot,
    };
  });

describe("source adapter fixture matrix", () => {
  it.effect(
    "imports the raw recorded Vercel OpenAPI spec into IR and discover projections",
    () =>
      Effect.gen(function* () {
        const specText = readFixture("vercel-openapi.json");
        const source = makeSource({
          id: "src_vercel_fixture",
          name: "Vercel",
          kind: "openapi",
          endpoint: "https://api.vercel.com",
          namespace: "vercel",
          binding: {
            specUrl: "https://openapi.vercel.sh/",
            defaultHeaders: null,
          },
        });
        const { manifest, snapshot } = yield* openApiSnapshotFromFixture({
          source,
          specText,
          documentKey: "https://openapi.vercel.sh/",
        });
        const tool = yield* expandCatalogToolByPath({
          catalogs: [makeLoadedCatalog({ source, snapshot })],
          path: "vercel.projects.addProjectDomain",
          includeSchemas: true,
        });

        expect(manifest.tools.length).toBeGreaterThan(250);
        expect(Object.keys(snapshot.catalog.capabilities).length).toBeGreaterThan(250);
        expect(tool).toBeDefined();
        expect(tool?.descriptor.previewInputType).not.toContain("unknown");
        expect(tool?.descriptor.previewOutputType).toContain("data:");
        expect(tool?.descriptor.previewOutputType).toContain("status:");
        expect(tool?.descriptor.inputSchema).toMatchObject({
          type: "object",
          properties: {
            idOrName: {
              type: "string",
            },
            body: {
              type: "object",
            },
          },
        });
        expect(
          unresolvedDiagnosticsForPrefix(snapshot, "#/openapi/addProjectDomain"),
        ).toEqual([]);
        expect(
          Object.values(snapshot.catalog.capabilities).some(
            (capability) => capability.auth.kind !== "none",
          ),
        ).toBe(true);
        expect(
          Object.values(snapshot.catalog.responseSets).some((responseSet) =>
            responseSet.variants.some(
              (variant) => variant.match.kind === "exact" && variant.match.status >= 400,
            ),
          ),
        ).toBe(true);
      }),
    120_000,
  );

  it.effect(
    "imports the raw recorded Neon OpenAPI spec into IR with resolved request body schemas",
    () =>
      Effect.gen(function* () {
        const specText = readFixture("neon-openapi.json");
        const source = makeSource({
          id: "src_neon_fixture",
          name: "Neon API",
          kind: "openapi",
          endpoint: "https://console.neon.tech/api/v2",
          namespace: "neon",
          binding: {
            specUrl: "https://neon.com/api_spec/release/v2.json",
            defaultHeaders: null,
          },
        });
        const { manifest, snapshot } = yield* openApiSnapshotFromFixture({
          source,
          specText,
          documentKey: "https://neon.com/api_spec/release/v2.json",
        });
        const tool = yield* expandCatalogToolByPath({
          catalogs: [makeLoadedCatalog({ source, snapshot })],
          path: "neon.apiKey.createApiKey",
          includeSchemas: true,
        });

        expect(manifest.tools.length).toBeGreaterThan(50);
        expect(tool).toBeDefined();
        expect(tool?.descriptor.previewInputType).toContain("key_name");
        expect(tool?.descriptor.inputSchema).toMatchObject({
          type: "object",
          properties: {
            body: {
              type: "object",
              properties: {
                key_name: {
                  type: "string",
                },
              },
              required: ["key_name"],
            },
          },
          required: ["body"],
        });
        expect(tool?.descriptor.outputSchema).toMatchObject({
          type: "object",
          properties: {
            data: {
              anyOf: expect.any(Array),
            },
          },
        });
        const dataVariants =
          (tool?.descriptor.outputSchema as { properties?: { data?: { anyOf?: Array<Record<string, unknown>> } } })
            .properties?.data?.anyOf ?? [];
        const objectDataVariant = dataVariants.find((variant) => variant.type === "object");
        expect(objectDataVariant).toMatchObject({
          properties: {
            id: {
              type: "integer",
            },
            key: {
              type: "string",
            },
            name: {
              type: "string",
            },
          },
        });
        expect(
          unresolvedDiagnosticsForPrefix(snapshot, "#/openapi/apiKey.createApiKey"),
        ).toEqual([]);
    }),
    120_000,
  );

  it.effect(
    "executes imported OpenAPI tools with scoped servers and serialized parameters",
    () =>
      Effect.tryPromise({
        try: async () => {
          const requests: Array<{
            method: string;
            path: string;
            query: string;
            headers: Record<string, string | string[] | undefined>;
            body: string;
          }> = [];

          const server = createServer((request, response) => {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk) => {
              body += chunk;
            });
            request.on("end", () => {
              const url = new URL(request.url ?? "/", "http://127.0.0.1");
              requests.push({
                method: request.method ?? "GET",
                path: url.pathname,
                query: url.search,
                headers: request.headers,
                body,
              });
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.setHeader("x-request-id", `req_${String(requests.length)}`);
              response.end(JSON.stringify({ ok: true }));
            });
          });

          await new Promise<void>((resolve, reject) => {
            server.listen(0, "127.0.0.1", (error?: Error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          });

          try {
            const address = server.address();
            if (!address || typeof address === "string") {
              throw new Error("Failed to resolve execution fixture server");
            }

            const baseUrl = `http://127.0.0.1:${address.port}`;
            const source = makeSource({
              id: "src_openapi_execution_fixture",
              name: "Serialized API",
              kind: "openapi",
              endpoint: baseUrl,
              namespace: "serialized",
              binding: {
                specUrl: `${baseUrl}/openapi.json`,
                defaultHeaders: null,
              },
            });
            const specText = JSON.stringify({
              openapi: "3.1.0",
              info: {
                title: "Serialized API",
                version: "1.0.0",
              },
              servers: [{
                url: "/v1",
              }],
              paths: {
                "/items/{itemId}": {
                  get: {
                    operationId: "items.getItem",
                    servers: [{
                      url: "/v2",
                    }],
                    parameters: [
                      {
                        name: "itemId",
                        in: "path",
                        required: true,
                        style: "label",
                        explode: true,
                        schema: {
                          type: "array",
                          items: {
                            type: "string",
                          },
                        },
                      },
                      {
                        name: "filter",
                        in: "query",
                        style: "deepObject",
                        explode: true,
                        schema: {
                          type: "object",
                          additionalProperties: {
                            type: "string",
                          },
                        },
                      },
                      {
                        name: "search",
                        in: "query",
                        allowReserved: true,
                        schema: {
                          type: "string",
                        },
                      },
                      {
                        name: "X-Trace",
                        in: "header",
                        schema: {
                          type: "array",
                          items: {
                            type: "string",
                          },
                        },
                      },
                    ],
                    responses: {
                      "200": {
                        description: "ok",
                        content: {
                          "application/json": {
                            schema: {
                              type: "object",
                              properties: {
                                ok: {
                                  type: "boolean",
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                "/forms": {
                  post: {
                    operationId: "forms.submit",
                    requestBody: {
                      required: true,
                      content: {
                        "application/x-www-form-urlencoded": {
                          schema: {
                            type: "object",
                            properties: {
                              title: {
                                type: "string",
                              },
                              state: {
                                type: "string",
                              },
                            },
                            required: ["title"],
                          },
                        },
                      },
                    },
                    responses: {
                      "200": {
                        description: "ok",
                        content: {
                          "application/json": {
                            schema: {
                              type: "object",
                              properties: {
                                ok: {
                                  type: "boolean",
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            });

            const { snapshot } = await Effect.runPromise(
              openApiSnapshotFromFixture({
                source,
                specText,
                documentKey: `${baseUrl}/openapi.json`,
              }),
            );
            const loadedCatalog = makeLoadedCatalog({
              source,
              snapshot,
            });
            const getItemTool = await Effect.runPromise(
              expandCatalogToolByPath({
                catalogs: [loadedCatalog],
                path: "serialized.items.getItem",
              }),
            );
            const submitFormTool = await Effect.runPromise(
              expandCatalogToolByPath({
                catalogs: [loadedCatalog],
                path: "serialized.forms.submit",
              }),
            );

            if (!getItemTool || !submitFormTool) {
              throw new Error("Expected OpenAPI execution fixture tools to resolve");
            }

            const auth = {
              placements: [],
              headers: {},
              queryParams: {},
              cookies: {},
              bodyValues: {},
              expiresAt: null,
              refreshAfter: null,
            } as const;

            const getItemResult = await Effect.runPromise(
              invokeIrTool({
                workspaceId: source.workspaceId,
                accountId: "acct_fixture" as any,
                tool: getItemTool,
                auth,
                args: {
                  itemId: ["alpha", "beta"],
                  filter: {
                    status: "open",
                  },
                  search: "refs/heads/main?draft=true",
                  "X-Trace": ["a", "b"],
                },
              }),
            );
            const submitFormResult = await Effect.runPromise(
              invokeIrTool({
                workspaceId: source.workspaceId,
                accountId: "acct_fixture" as any,
                tool: submitFormTool,
                auth,
                args: {
                  body: {
                    title: "Bug report",
                    state: "open",
                  },
                },
              }),
            );

            expect(getItemResult).toMatchObject({
              data: { ok: true },
              error: null,
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-request-id": "req_1",
              },
            });
            expect(submitFormResult).toMatchObject({
              data: { ok: true },
              error: null,
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-request-id": "req_2",
              },
            });
            expect(requests).toHaveLength(2);
            expect(requests[0]?.path).toBe("/v2/items/.alpha.beta");
            expect(requests[0]?.query).toContain("filter%5Bstatus%5D=open");
            expect(requests[0]?.query).toContain("search=refs/heads/main?draft=true");
            expect(requests[0]?.headers["x-trace"]).toBe("a,b");
            expect(requests[1]?.path).toBe("/v1/forms");
            expect(String(requests[1]?.headers["content-type"])).toContain("application/x-www-form-urlencoded");
            expect(requests[1]?.body).toContain("title=Bug+report");
            expect(requests[1]?.body).toContain("state=open");
          } finally {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            });
          }
        },
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }),
    120_000,
  );

  it.effect(
    "imports the raw recorded Google Sheets discovery document into IR and discover projections",
    () =>
      Effect.gen(function* () {
        const documentText = readFixture("google-sheets-discovery.json");
        const source = makeSource({
          id: "src_google_sheets_fixture",
          name: "Google Sheets",
          kind: "google_discovery",
          endpoint: "https://sheets.googleapis.com/",
          namespace: "google.sheets",
          binding: {
            service: "sheets",
            version: "v4",
            discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
            defaultHeaders: null,
            scopes: [],
          },
        });
        const { manifest, snapshot } = yield* googleDiscoverySnapshotFromFixture({
          source,
          documentText,
          documentKey: "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
        });
        const tool = yield* expandCatalogToolByPath({
          catalogs: [makeLoadedCatalog({ source, snapshot })],
          path: "google.sheets.spreadsheets.sheets.copyTo",
          includeSchemas: true,
        });

        expect(manifest.service).toBe("sheets");
        expect(Object.keys(snapshot.catalog.capabilities).length).toBeGreaterThan(10);
        expect(tool).toBeDefined();
        expect(tool?.descriptor.previewInputType).not.toContain("unknown");
        expect(tool?.descriptor.previewOutputType).toContain("data:");
        expect(tool?.descriptor.previewOutputType).toContain("status:");
        expect(tool?.descriptor.inputSchema).toMatchObject({
          type: "object",
          properties: {
            spreadsheetId: {
              type: "string",
            },
            sheetId: {
              type: "integer",
            },
            body: {
              type: "object",
              properties: {
                destinationSpreadsheetId: {
                  type: "string",
                },
              },
            },
          },
        });
        expect(JSON.stringify(tool?.descriptor.outputSchema)).toContain("\"gridProperties\"");
        expect(
          unresolvedDiagnosticsForPrefix(
            snapshot,
            "#/googleDiscovery/spreadsheets.sheets.copyTo",
          ),
        ).toEqual([]);
    }),
    120_000,
  );

  it.effect(
    "projects every raw recorded Google Sheets discovery method into schemas and capabilities",
    () =>
      Effect.gen(function* () {
        const documentText = readFixture("google-sheets-discovery.json");
        const source = makeSource({
          id: "src_google_sheets_coverage",
          name: "Google Sheets",
          kind: "google_discovery",
          endpoint: "https://sheets.googleapis.com/",
          namespace: "google.sheets",
          binding: {
            service: "sheets",
            version: "v4",
            discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
            defaultHeaders: null,
            scopes: [],
          },
        });
        const { manifest, snapshot } = yield* googleDiscoverySnapshotFromFixture({
          source,
          documentText,
          documentKey: "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
        });

        const mismatches = compileGoogleDiscoveryToolDefinitions(manifest).flatMap((definition) => {
          const presentation = buildGoogleDiscoveryToolPresentation({
            manifest,
            definition,
          });
          const issues: string[] = [];

          if ((definition.parameters.length > 0 || definition.requestSchemaId) && presentation.inputSchema === undefined) {
            issues.push(`${definition.toolId}: missing input schema`);
          }
          if (definition.responseSchemaId && presentation.outputSchema === undefined) {
            issues.push(`${definition.toolId}: missing output schema`);
          }

          return issues;
        });

        expect(manifest.methods.length).toBeGreaterThan(10);
        expect(Object.keys(snapshot.catalog.capabilities).length).toBe(
          manifest.methods.length,
        );
        expect(mismatches).toEqual([]);
      }),
    120_000,
  );

  it.effect(
    "imports the raw recorded Linear GraphQL introspection dump into IR and resolves nested input refs",
    () =>
      Effect.gen(function* () {
        const documentText = readFixture("linear-introspection.json");
        const source = makeSource({
          id: "src_linear_fixture",
          name: "Linear GraphQL",
          kind: "graphql",
          endpoint: "https://api.linear.app/graphql",
          namespace: "linear",
          binding: {
            defaultHeaders: null,
          },
        });
        const { manifest, snapshot } = yield* graphqlSnapshotFromFixture({
          source,
          documentText,
        });
        const tool = yield* expandCatalogToolByPath({
          catalogs: [makeLoadedCatalog({ source, snapshot })],
          path: "linear.agentActivityCreatePrompt",
          includeSchemas: true,
        });

        expect(manifest.tools.length).toBeGreaterThan(100);
        expect(Object.keys(snapshot.catalog.capabilities).length).toBeGreaterThan(100);
        expect(
          Object.values(snapshot.catalog.diagnostics).filter(
            (diagnostic) => diagnostic.code === "unresolved_ref",
          ),
        ).toEqual([]);
        expect(tool).toBeDefined();
        expect(tool?.descriptor.previewInputType).toContain("args: {");
        expect(tool?.descriptor.previewInputType).toContain("input: {");
        expect(tool?.descriptor.previewOutputType).toContain("data:");
        expect(tool?.descriptor.previewOutputType).not.toContain("unknown[]");
        expect(tool?.descriptor.inputSchema).toMatchObject({
          type: "object",
          required: ["args"],
          properties: {
            args: {
              type: "object",
              required: ["input"],
              properties: {
                input: {
                  type: "object",
                  required: ["agentSessionId", "content"],
                  properties: {
                    agentSessionId: {
                      type: "string",
                    },
                    content: {
                      type: "object",
                      properties: {
                        body: {
                          type: "string",
                        },
                      },
                    },
                    sourceCommentId: {
                      type: "string",
                    },
                  },
                },
                headers: {
                  type: "object",
                },
              },
            },
          },
        });
        expect(
          unresolvedDiagnosticsForPrefix(
            snapshot,
            "#/graphql/agentActivityCreatePrompt",
          ),
        ).toEqual([]);
    }),
    120_000,
  );

  it.effect(
    "executes persisted GraphQL field tools with normalized response envelopes",
    () =>
      Effect.gen(function* () {
        const requests: Array<{
          body: string;
          headers: Record<string, string | string[] | undefined>;
          path: string;
        }> = [];

        const server = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            requests.push({
              body,
              headers: request.headers,
              path: request.url ?? "/",
            });
            response.statusCode = 200;
            response.setHeader("content-type", "application/json");
            response.setHeader("x-request-id", "req_graphql_1");
            response.end(JSON.stringify({
              data: {
                viewer: {
                  login: "alice",
                },
              },
            }));
          });
        });

        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              server.listen(0, "127.0.0.1", (error?: Error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }),
          catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
        });

        try {
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Failed to resolve GraphQL execution fixture server");
          }

          const baseUrl = `http://127.0.0.1:${address.port}`;
          const source = makeSource({
            id: "src_graphql_execution_fixture",
            name: "GraphQL Fixture",
            kind: "graphql",
            endpoint: `${baseUrl}/graphql`,
            namespace: "gqlfixture",
            binding: {
              defaultHeaders: null,
            },
          });
          const snapshot = createGraphqlCatalogSnapshot({
            source,
            documents: [{
              documentKind: "graphql_introspection",
              documentKey: `${baseUrl}/graphql`,
              contentText: "{}",
              fetchedAt: 1,
            }],
            operations: [{
              toolId: "viewer",
              title: "Viewer",
              description: "Fetch the current viewer.",
              effect: "read",
              inputSchema: {
                type: "object",
                additionalProperties: false,
              },
              outputSchema: {
                type: "object",
                properties: {
                  data: {
                    type: "object",
                    properties: {
                      login: {
                        type: "string",
                      },
                    },
                    required: ["login"],
                    additionalProperties: false,
                  },
                  errors: {
                    type: "array",
                    items: {},
                  },
                  isError: {
                    type: "boolean",
                  },
                },
                required: ["data", "errors", "isError"],
                additionalProperties: false,
              },
              providerData: {
                kind: "graphql",
                toolKind: "field",
                toolId: "viewer",
                rawToolId: "viewer",
                group: "query",
                leaf: "viewer",
                fieldName: "viewer",
                operationType: "query",
                operationName: "ViewerQuery",
                operationDocument: "query ViewerQuery { viewer { login } }",
                queryTypeName: "Query",
                mutationTypeName: null,
                subscriptionTypeName: null,
              },
            }],
          });
          const loadedCatalog = makeLoadedCatalog({
            source,
            snapshot,
          });
          const tool = yield* expandCatalogToolByPath({
            catalogs: [loadedCatalog],
            path: "gqlfixture.viewer",
          });

          if (!tool) {
            throw new Error("Expected GraphQL execution fixture tool to resolve");
          }

          const auth = {
            placements: [],
            headers: {},
            queryParams: {},
            cookies: {},
            bodyValues: {},
            expiresAt: null,
            refreshAfter: null,
          } as const;

          const result = yield* invokeIrTool({
            workspaceId: source.workspaceId,
            accountId: "acct_fixture" as any,
            tool,
            auth,
            args: {},
          });

          expect(result).toMatchObject({
            data: {
              login: "alice",
            },
            error: null,
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_graphql_1",
            },
          });
          expect(requests).toHaveLength(1);
          expect(requests[0]?.path).toBe("/graphql");
          expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
            query: "query ViewerQuery { viewer { login } }",
            variables: {},
            operationName: "ViewerQuery",
          });
        } finally {
          yield* Effect.tryPromise({
            try: () =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => {
                  if (error) {
                    reject(error);
                    return;
                  }
                  resolve();
                });
              }),
            catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
          });
        }
      }),
  );

  it.effect(
    "projects every raw recorded Linear GraphQL tool into schemas and capabilities",
    () =>
      Effect.gen(function* () {
        const documentText = readFixture("linear-introspection.json");
        const source = makeSource({
          id: "src_linear_coverage",
          name: "Linear GraphQL",
          kind: "graphql",
          endpoint: "https://api.linear.app/graphql",
          namespace: "linear",
          binding: {
            defaultHeaders: null,
          },
        });
        const { manifest, snapshot } = yield* graphqlSnapshotFromFixture({
          source,
          documentText,
        });

        const mismatches = compileGraphqlToolDefinitions(manifest).flatMap((definition) => {
          const presentation = buildGraphqlToolPresentation({
            manifest,
            definition,
          });
          const issues: string[] = [];

          if (definition.operationType && presentation.outputSchema === undefined) {
            issues.push(`${definition.toolId}: missing output schema`);
          }
          if (JSON.stringify(presentation.inputSchema ?? {}).includes("shape_")) {
            issues.push(`${definition.toolId}: leaked internal shape id in input schema`);
          }
          if (JSON.stringify(presentation.outputSchema ?? {}).includes("shape_")) {
            issues.push(`${definition.toolId}: leaked internal shape id in output schema`);
          }

          return issues;
        });

        expect(manifest.tools.length).toBeGreaterThan(100);
        expect(Object.keys(snapshot.catalog.capabilities).length).toBe(
          manifest.tools.length,
        );
        expect(
          Object.values(snapshot.catalog.diagnostics).filter(
            (diagnostic) => diagnostic.code === "unresolved_ref",
          ),
        ).toEqual([]);
        expect(mismatches).toEqual([]);
      }),
    120_000,
  );
});
