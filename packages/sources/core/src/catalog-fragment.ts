import {
  DocumentIdSchema,
  ResourceIdSchema,
  ScopeIdSchema,
} from "@executor/ir/ids";
import type {
  CatalogFragmentV1,
  Scope,
  SourceDocument,
} from "@executor/ir/model";

import { namespaceFromSourceName } from "./discovery";
import type { Source } from "./source-models";
import {
  docsFrom,
  mutableRecord,
  provenanceFor,
  sourceKindFromSource,
  stableHash,
} from "./catalog-shared";
import { createJsonSchemaImporter } from "./catalog-json-schema";
import type {
  CatalogFragmentBuildContext,
  CatalogFragmentBuilder,
  CatalogSourceDocumentInput,
} from "./catalog-types";

const serviceScopeIdForSource = (source: Pick<Source, "id">) =>
  ScopeIdSchema.make(`scope_service_${stableHash({ sourceId: source.id })}`);

const documentIdFor = (source: Pick<Source, "id">, key: string) =>
  DocumentIdSchema.make(`doc_${stableHash({ sourceId: source.id, key })}`);

const resourceIdForSource = (source: Pick<Source, "id">) =>
  ResourceIdSchema.make(`res_${stableHash({ sourceId: source.id })}`);

const nativeBlob = (input: {
  source: Pick<Source, "kind">;
  kind: string;
  pointer: string;
  value: unknown;
  summary?: string;
}) => ({
  sourceKind: sourceKindFromSource(input.source),
  kind: input.kind,
  pointer: input.pointer,
  encoding: "json" as const,
  ...(input.summary ? { summary: input.summary } : {}),
  value: input.value,
});

const createEmptyCatalogFragment = (): CatalogFragmentBuilder => ({
  version: "ir.v1.fragment",
  documents: {},
  resources: {},
  scopes: {},
  symbols: {},
  capabilities: {},
  executables: {},
  responseSets: {},
  diagnostics: {},
});

const finalizeCatalogFragment = (
  fragment: CatalogFragmentBuilder,
): CatalogFragmentV1 => ({
  version: "ir.v1.fragment",
  ...(Object.keys(fragment.documents).length > 0
    ? { documents: fragment.documents }
    : {}),
  ...(Object.keys(fragment.resources).length > 0
    ? { resources: fragment.resources }
    : {}),
  ...(Object.keys(fragment.scopes).length > 0
    ? { scopes: fragment.scopes }
    : {}),
  ...(Object.keys(fragment.symbols).length > 0
    ? { symbols: fragment.symbols }
    : {}),
  ...(Object.keys(fragment.capabilities).length > 0
    ? { capabilities: fragment.capabilities }
    : {}),
  ...(Object.keys(fragment.executables).length > 0
    ? { executables: fragment.executables }
    : {}),
  ...(Object.keys(fragment.responseSets).length > 0
    ? { responseSets: fragment.responseSets }
    : {}),
  ...(Object.keys(fragment.diagnostics).length > 0
    ? { diagnostics: fragment.diagnostics }
    : {}),
});

const createServiceScope = (input: {
  catalog: CatalogFragmentBuilder;
  source: Pick<Source, "id" | "name" | "namespace">;
  documentId: ReturnType<typeof DocumentIdSchema.make>;
  defaults?: Scope["defaults"];
}) => {
  const scopeId = serviceScopeIdForSource(input.source);
  mutableRecord(input.catalog.scopes)[scopeId] = {
    id: scopeId,
    kind: "service",
    name: input.source.name,
    namespace:
      input.source.namespace ?? namespaceFromSourceName(input.source.name),
    docs: docsFrom({
      summary: input.source.name,
    }),
    ...(input.defaults ? { defaults: input.defaults } : {}),
    synthetic: false,
    provenance: provenanceFor(input.documentId, "#/service"),
  } satisfies Scope;
  return scopeId;
};

export const buildCatalogFragment = (input: {
  source: Pick<
    Source,
    "id" | "kind" | "name" | "namespace"
  >;
  documents: readonly CatalogSourceDocumentInput[];
  serviceScopeDefaults?: Scope["defaults"];
  resourceDialectUri?: string;
  registerOperations: (context: CatalogFragmentBuildContext) => void;
}): CatalogFragmentV1 => {
  const catalog = createEmptyCatalogFragment();
  const documents =
    input.documents.length > 0
      ? input.documents
      : [
          {
            documentKind: "synthetic",
            documentKey: input.source.id,
            fetchedAt: Date.now(),
            contentText: "{}",
          },
        ];
  const primaryDocument = documents[0]!;
  const primaryDocumentKey =
    primaryDocument.documentKey ?? input.source.id;
  const primaryDocumentId = documentIdFor(
    input.source,
    `${primaryDocument.documentKind}:${primaryDocument.documentKey}`,
  );
  const primaryResourceId = resourceIdForSource(input.source);

  for (const document of documents) {
    const documentId = documentIdFor(
      input.source,
      `${document.documentKind}:${document.documentKey}`,
    );
    mutableRecord(catalog.documents)[documentId] = {
      id: documentId,
      kind: sourceKindFromSource(input.source),
      title: input.source.name,
      fetchedAt: new Date(document.fetchedAt ?? Date.now()).toISOString(),
      rawRef: document.documentKey,
      entryUri: document.documentKey.startsWith("http")
        ? document.documentKey
        : undefined,
      native: [
        nativeBlob({
          source: input.source,
          kind: "source_document",
          pointer: `#/${document.documentKind}`,
          value: document.contentText,
          summary: document.documentKind,
        }),
      ],
    } satisfies SourceDocument;
  }

  mutableRecord(catalog.resources)[primaryResourceId] = {
    id: primaryResourceId,
    documentId: primaryDocumentId,
    canonicalUri: primaryDocumentKey,
    baseUri: primaryDocumentKey,
    ...(input.resourceDialectUri
      ? {
          dialectUri: input.resourceDialectUri,
        }
      : {}),
    anchors: {},
    dynamicAnchors: {},
    synthetic: false,
    provenance: provenanceFor(primaryDocumentId, "#"),
  };

  const serviceScopeId = createServiceScope({
    catalog,
    source: input.source,
    documentId: primaryDocumentId,
    defaults: input.serviceScopeDefaults,
  });
  const importer = createJsonSchemaImporter({
    catalog,
    source: input.source,
    resourceId: primaryResourceId,
    documentId: primaryDocumentId,
  });
  input.registerOperations({
    catalog,
    documentId: primaryDocumentId,
    serviceScopeId,
    importer,
  });
  importer.finalize();

  return finalizeCatalogFragment(catalog);
};
