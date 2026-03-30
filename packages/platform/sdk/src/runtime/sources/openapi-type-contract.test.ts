import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { fileURLToPath } from "node:url";

import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import { projectCatalogForAgentSdk } from "@executor/ir/catalog";
import {
  createCatalogImportMetadata,
  createSourceCatalogSyncResult,
  snapshotFromSourceCatalogSyncResult,
} from "@executor/source-core";
import * as Effect from "effect/Effect";

import type {
  StoredSourceCatalogRevisionRecord,
} from "../../schema/models/source-catalog";
import type {
  Source,
  StoredSourceRecord,
} from "../../schema/models/source";
import {
  createCatalogTypeProjector,
  projectedCatalogTypeRoots,
} from "../catalog/catalog-typescript";
import type {
  LoadedSourceCatalog,
} from "../catalog/source/runtime";
import {
  buildLoadedSourceCatalogToolContract,
  expandCatalogTools,
} from "../catalog/source/runtime";
import {
  createOpenApiCatalogFragment,
  openApiCatalogOperationFromDefinition,
} from "../../../../../../plugins/openapi/sdk/catalog";
import {
  compileOpenApiToolDefinitions,
} from "../../../../../../plugins/openapi/sdk/definitions";
import {
  extractOpenApiManifest,
} from "../../../../../../plugins/openapi/sdk/extraction";

const vercelFixturePath = fileURLToPath(
  new URL("../fixtures/vercel-openapi.json", import.meta.url),
);

const noContentSuccessOpenApiFixture = JSON.stringify({
  openapi: "3.1.0",
  info: {
    title: "GitHub REST API",
    version: "1.0.0",
  },
  servers: [
    {
      url: "https://api.github.com",
    },
  ],
  paths: {
    "/user/starred/{owner}/{repo}": {
      get: {
        operationId: "checkRepoIsStarredByAuthenticatedUser",
        summary: "Check if a repository is starred by the authenticated user",
        parameters: [
          {
            name: "owner",
            in: "path",
            required: true,
            schema: {
              type: "string",
            },
          },
          {
            name: "repo",
            in: "path",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          "204": {
            description: "Response if this repository is starred by you",
          },
          "404": {
            description: "Not Found if this repository is not starred by you",
          },
        },
      },
    },
  },
});

const sharedRefOpenApiFixture = JSON.stringify({
  openapi: "3.1.0",
  info: {
    title: "Shared Ref API",
    version: "1.0.0",
  },
  servers: [
    {
      url: "https://api.example.test",
    },
  ],
  paths: {
    "/widgets/{widgetId}": {
      get: {
        operationId: "getWidget",
        parameters: [
          {
            name: "widgetId",
            in: "path",
            required: true,
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          "200": {
            description: "Widget response",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/Widget",
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Widget: {
        type: "object",
        required: ["id", "name", "owner"],
        properties: {
          id: {
            type: "string",
          },
          name: {
            type: "string",
          },
          owner: {
            $ref: "#/components/schemas/Owner",
          },
        },
      },
      Owner: {
        type: "object",
        required: ["email"],
        properties: {
          email: {
            type: "string",
          },
        },
      },
    },
  },
});

const makeSource = (input: {
  id?: string;
  name?: string;
  namespace?: string;
} = {}): Source => ({
  id: input.id ?? "source_vercel_api",
  scopeId: "scope_test",
  name: input.name ?? "Vercel API",
  kind: "openapi",
  status: "connected",
  enabled: true,
  namespace: input.namespace ?? "vercel-api",
  createdAt: 0,
  updatedAt: 0,
});

const makeRevision = (): StoredSourceCatalogRevisionRecord => ({
  id: "catalog_revision_vercel",
  catalogId: "catalog_vercel",
  revisionNumber: 1,
  sourceConfigJson: "{}",
  importMetadataJson: null,
  importMetadataHash: null,
  snapshotHash: null,
  createdAt: 0,
  updatedAt: 0,
});

const makeSourceRecord = (
  source: Source,
  revision: StoredSourceCatalogRevisionRecord,
): StoredSourceRecord => ({
  id: source.id,
  scopeId: source.scopeId,
  catalogId: revision.catalogId,
  catalogRevisionId: revision.id,
  name: source.name,
  kind: source.kind,
  status: source.status,
  enabled: source.enabled,
  namespace: source.namespace,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});

describe("openapi type contracts", () => {
  it.effect("resolves nested component refs in OpenAPI call contracts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const vercelFixture = yield* fs.readFileString(vercelFixturePath, "utf8");
      const source = makeSource();
      const manifest = yield* extractOpenApiManifest(source.name, vercelFixture);
      const operations = compileOpenApiToolDefinitions(manifest).map(
        openApiCatalogOperationFromDefinition,
      );
      const fragment = createOpenApiCatalogFragment({
        source,
        documents: [
          {
            documentKind: "openapi",
            documentKey: "https://example.com/vercel-openapi.json",
            fetchedAt: 0,
            contentText: vercelFixture,
          },
        ],
        operations,
      });
      const snapshot = snapshotFromSourceCatalogSyncResult(
        createSourceCatalogSyncResult({
          fragment,
          importMetadata: createCatalogImportMetadata({
            source,
            pluginKey: "openapi",
          }),
          sourceHash: manifest.sourceHash,
        }),
      );
      const projected = projectCatalogForAgentSdk({
        catalog: snapshot.catalog,
      });
      const revision = makeRevision();
      const loadedCatalog: LoadedSourceCatalog = {
        source,
        sourceRecord: makeSourceRecord(source, revision),
        revision,
        snapshot,
        catalog: snapshot.catalog,
        projected,
        typeProjector: createCatalogTypeProjector({
          catalog: projected.catalog,
          roots: projectedCatalogTypeRoots(projected),
        }),
        importMetadata: snapshot.import,
      };

      const tools = yield* expandCatalogTools({
        catalogs: [loadedCatalog],
        includeSchemas: true,
        includeTypePreviews: true,
      });
      const tool = tools.find((candidate) =>
        candidate.path === "vercel-api.domainsRegistrar.buyDomains"
      );

      expect(tool).toBeDefined();

      const contract = yield* buildLoadedSourceCatalogToolContract(tool!);
      const declaration = contract.input.typeDeclaration ?? "";

      expect(declaration).toContain("type VercelApiDomainsRegistrarBuyDomainsCall");
      expect(declaration).toContain("firstName: string;");
      expect(declaration).toContain("lastName: string;");
      expect(declaration).toContain("email: string;");
      expect(declaration).toContain("phone: string;");
      expect(declaration).toContain("address1: string;");
      expect(declaration).toContain("city: string;");
      expect(declaration).toContain("state: string;");
      expect(declaration).toContain("zip: string;");
      expect(declaration).toContain("country: string;");
      expect(declaration).not.toContain("firstName: unknown;");
      expect(declaration).not.toContain("email: unknown;");
      expect(declaration).not.toContain("country: unknown;");
    }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.effect("renders null success data for bodyless OpenAPI responses", () =>
    Effect.gen(function* () {
      const source = makeSource({
        id: "source_github_v3_rest_api",
        name: "GitHub REST API",
        namespace: "github-v3-rest-api",
      });
      const manifest = yield* extractOpenApiManifest(
        source.name,
        noContentSuccessOpenApiFixture,
      );
      const operations = compileOpenApiToolDefinitions(manifest).map(
        openApiCatalogOperationFromDefinition,
      );
      const fragment = createOpenApiCatalogFragment({
        source,
        documents: [
          {
            documentKind: "openapi",
            documentKey: "https://example.com/github-rest-openapi.json",
            fetchedAt: 0,
            contentText: noContentSuccessOpenApiFixture,
          },
        ],
        operations,
      });
      const snapshot = snapshotFromSourceCatalogSyncResult(
        createSourceCatalogSyncResult({
          fragment,
          importMetadata: createCatalogImportMetadata({
            source,
            pluginKey: "openapi",
          }),
          sourceHash: manifest.sourceHash,
        }),
      );
      const projected = projectCatalogForAgentSdk({
        catalog: snapshot.catalog,
      });
      const revision = makeRevision();
      const loadedCatalog: LoadedSourceCatalog = {
        source,
        sourceRecord: makeSourceRecord(source, revision),
        revision,
        snapshot,
        catalog: snapshot.catalog,
        projected,
        typeProjector: createCatalogTypeProjector({
          catalog: projected.catalog,
          roots: projectedCatalogTypeRoots(projected),
        }),
        importMetadata: snapshot.import,
      };

      const tools = yield* expandCatalogTools({
        catalogs: [loadedCatalog],
        includeSchemas: true,
        includeTypePreviews: true,
      });
      const tool = tools.find((candidate) =>
        candidate.path.endsWith(".checkRepoIsStarredByAuthenticatedUser")
      );

      expect(tool).toBeDefined();

      const contract = yield* buildLoadedSourceCatalogToolContract(tool!);

      expect(contract.output.typeDeclaration).toContain("data: null;");
      expect(contract.output.typeDeclaration).not.toContain("data: unknown");
      expect(contract.output.typePreview).toContain("data: null");
    }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.effect("preserves local component refs in IR and keeps executable bindings runtime-minimal", () =>
    Effect.gen(function* () {
      const source = makeSource({
        id: "source_shared_ref_api",
        name: "Shared Ref API",
        namespace: "shared-ref-api",
      });
      const manifest = yield* extractOpenApiManifest(
        source.name,
        sharedRefOpenApiFixture,
      );
      const operations = compileOpenApiToolDefinitions(manifest).map(
        openApiCatalogOperationFromDefinition,
      );
      const fragment = createOpenApiCatalogFragment({
        source,
        documents: [
          {
            documentKind: "openapi",
            documentKey: "https://example.com/shared-ref-openapi.json",
            fetchedAt: 0,
            contentText: sharedRefOpenApiFixture,
          },
        ],
        operations,
      });
      const snapshot = snapshotFromSourceCatalogSyncResult(
        createSourceCatalogSyncResult({
          fragment,
          importMetadata: createCatalogImportMetadata({
            source,
            pluginKey: "openapi",
          }),
          sourceHash: manifest.sourceHash,
        }),
      );

      const refShapes = Object.values(snapshot.catalog.symbols).filter(
        (symbol) => symbol.kind === "shape" && symbol.node.type === "ref",
      );
      expect(refShapes.length).toBeGreaterThan(0);

      const executable = Object.values(snapshot.catalog.executables)[0];
      expect(executable).toBeDefined();
      expect(executable?.binding).toMatchObject({
        kind: "openapi",
        toolId: "widgets.getWidget",
      });
      expect((executable?.binding as Record<string, unknown>).responses).toBeUndefined();
      expect((executable?.binding as Record<string, unknown>).documentation).toBeUndefined();
      expect(JSON.stringify(executable?.binding).length).toBeLessThan(2_000);
    }));
});
