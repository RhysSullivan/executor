import { projectCatalogForAgentSdk } from "@executor/ir/catalog";
import {
  createCatalogImportMetadata,
  createSourceCatalogSyncResult,
  snapshotFromSourceCatalogSyncResult,
} from "@executor/source-core";
import * as Effect from "effect/Effect";

import type {
  StoredSourceCatalogRevisionRecord,
} from "../../../packages/platform/sdk/src/schema/models/source-catalog";
import type {
  Source,
  StoredSourceRecord,
} from "../../../packages/platform/sdk/src/schema/models/source";
import {
  ScopeIdSchema,
  SourceCatalogIdSchema,
  SourceCatalogRevisionIdSchema,
  SourceIdSchema,
} from "../../../packages/platform/sdk/src/schema/ids";
import {
  createCatalogTypeProjector,
  projectedCatalogTypeRoots,
} from "../../../packages/platform/sdk/src/runtime/catalog/catalog-typescript";
import type {
  LoadedSourceCatalog,
} from "../../../packages/platform/sdk/src/runtime/catalog/source/runtime";
import {
  expandCatalogTools,
} from "../../../packages/platform/sdk/src/runtime/catalog/source/runtime";
import {
  createOpenApiCatalogFragment,
  openApiCatalogOperationFromDefinition,
} from "./catalog";
import {
  compileOpenApiToolDefinitions,
} from "./definitions";
import type {
  OpenApiManifestExtractionOptions,
} from "./extraction";
import {
  extractOpenApiManifest,
} from "./extraction";

export type OpenApiTestHarnessInput = {
  name: string;
  contentText: string;
  documentKey: string;
  namespace?: string;
  sourceId?: string;
  scopeId?: string;
  extraction?: OpenApiManifestExtractionOptions;
};

const createSource = (input: OpenApiTestHarnessInput): Source => ({
  id: SourceIdSchema.make(
    input.sourceId ?? `source_${input.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
  ),
  scopeId: ScopeIdSchema.make(input.scopeId ?? "scope_test"),
  name: input.name,
  kind: "openapi",
  status: "connected",
  enabled: true,
  namespace:
    input.namespace ?? input.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
  createdAt: 0,
  updatedAt: 0,
});

const createRevision = (source: Source): StoredSourceCatalogRevisionRecord => ({
  id: SourceCatalogRevisionIdSchema.make(`catalog_revision_${source.id}`),
  catalogId: SourceCatalogIdSchema.make(`catalog_${source.id}`),
  revisionNumber: 1,
  sourceConfigJson: "{}",
  importMetadataJson: null,
  importMetadataHash: null,
  snapshotHash: null,
  createdAt: 0,
  updatedAt: 0,
});

const createSourceRecord = (
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

export const buildOpenApiTestHarness = (input: OpenApiTestHarnessInput) =>
  Effect.gen(function* () {
    const source = createSource(input);
    const manifest = yield* extractOpenApiManifest(
      source.name,
      input.contentText,
      input.extraction,
    );
    const operations = compileOpenApiToolDefinitions(manifest).map(
      openApiCatalogOperationFromDefinition,
    );
    const fragment = createOpenApiCatalogFragment({
      source,
      documents: [
        {
          documentKind: "openapi",
          documentKey: input.documentKey,
          fetchedAt: 0,
          contentText: input.contentText,
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
    const revision = createRevision(source);
    const loadedCatalog: LoadedSourceCatalog = {
      source,
      sourceRecord: createSourceRecord(source, revision),
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

    return {
      source,
      manifest,
      operations,
      snapshot,
      loadedCatalog,
      tools,
    };
  });
