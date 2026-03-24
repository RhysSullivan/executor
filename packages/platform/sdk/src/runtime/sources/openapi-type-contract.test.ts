import { readFileSync } from "node:fs";

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

const vercelFixture = readFileSync(
  new URL("../fixtures/vercel-openapi.json", import.meta.url),
  "utf8",
);

const makeSource = (): Source => ({
  id: "source_vercel_api",
  scopeId: "scope_test",
  name: "Vercel API",
  kind: "openapi",
  status: "connected",
  enabled: true,
  namespace: "vercel-api",
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
    }));
});
