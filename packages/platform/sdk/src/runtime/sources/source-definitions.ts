import { sha256Hex } from "@executor/codemode-core";

import type {
  ScopeId,
  Source,
  SourceCatalogId,
  SourceCatalogKind,
  SourceCatalogPluginKey,
  SourceCatalogRevisionId,
  StoredSourceCatalogRecord,
  StoredSourceCatalogRevisionRecord,
} from "#schema";
import {
  SourceCatalogIdSchema,
  SourceCatalogRevisionIdSchema,
} from "#schema";
import * as Effect from "effect/Effect";

import { getSourceContributionForSource } from "./source-plugins";

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

type SourceCatalogSourceConfig = Record<string, unknown>;

const sourceConfigFromSource = (source: Source): SourceCatalogSourceConfig =>
  getSourceContributionForSource(source).catalogIdentity?.({
    source,
  }) ?? {
    kind: source.kind,
    namespace: source.namespace,
  };

const sourceCatalogKindFromSource = (source: Source): SourceCatalogKind =>
  getSourceContributionForSource(source).catalogKind;

const sourceCatalogPluginKeyFromSource = (source: Source): SourceCatalogPluginKey =>
  getSourceContributionForSource(source).kind;

const stableHash = (value: string): string =>
  sha256Hex(value).slice(0, 24);

const sourceCatalogSignature = (source: Source): string =>
  JSON.stringify({
    catalogKind: sourceCatalogKindFromSource(source),
    pluginKey: sourceCatalogPluginKeyFromSource(source),
    sourceId: source.id,
    sourceConfig: sourceConfigFromSource(source),
  });

export const sourceConfigSignature = (source: Source): string =>
  JSON.stringify({
    sourceId: source.id,
    kind: source.kind,
    name: source.name,
    namespace: source.namespace,
    enabled: source.enabled,
    updatedAt: source.updatedAt,
  });

export const stableSourceCatalogId = (source: Source): SourceCatalogId =>
  SourceCatalogIdSchema.make(`src_catalog_${stableHash(sourceCatalogSignature(source))}`);

export const stableSourceCatalogRevisionId = (
  source: Source,
): SourceCatalogRevisionId =>
  SourceCatalogRevisionIdSchema.make(`src_catalog_rev_${stableHash(sourceConfigSignature(source))}`);

const validateSourceByKind = (source: Source): Effect.Effect<Source, Error, never> =>
  Effect.succeed(source);

export const normalizeSourceForCreate = (input: {
  scopeId: ScopeId;
  sourceId: Source["id"];
  source: Omit<
    Source,
    "id" | "scopeId" | "createdAt" | "updatedAt"
  >;
  now: number;
}): Effect.Effect<Source, Error, never> =>
  validateSourceByKind({
    id: input.sourceId,
    scopeId: input.scopeId,
    name: input.source.name.trim(),
    kind: input.source.kind,
    status: input.source.status,
    enabled: input.source.enabled,
    namespace: trimOrNull(input.source.namespace),
    createdAt: input.now,
    updatedAt: input.now,
  });

export const normalizeSourceForSave = (input: {
  source: Source;
  now: number;
}): Effect.Effect<Source, Error, never> =>
  validateSourceByKind({
    ...input.source,
    name: input.source.name.trim(),
    namespace: trimOrNull(input.source.namespace),
    updatedAt: input.now,
  });

export const createSourceCatalogRecord = (input: {
  source: Source;
  catalogId?: SourceCatalogId | null;
  latestRevisionId: SourceCatalogRevisionId;
}): StoredSourceCatalogRecord => ({
  id: input.catalogId ?? stableSourceCatalogId(input.source),
  kind: sourceCatalogKindFromSource(input.source),
  pluginKey: sourceCatalogPluginKeyFromSource(input.source),
  name: input.source.name,
  summary: null,
  visibility: "scope",
  latestRevisionId: input.latestRevisionId,
  createdAt: input.source.createdAt,
  updatedAt: input.source.updatedAt,
});

export const createSourceCatalogRevisionRecord = (input: {
  source: Source;
  catalogId: SourceCatalogId;
  catalogRevisionId?: SourceCatalogRevisionId | null;
  revisionNumber: number;
  importMetadataJson?: string | null;
  importMetadataHash?: string | null;
  snapshotHash?: string | null;
}): StoredSourceCatalogRevisionRecord => ({
  id:
    input.catalogRevisionId
    ?? stableSourceCatalogRevisionId(input.source),
  catalogId: input.catalogId,
  revisionNumber: input.revisionNumber,
  sourceConfigJson: sourceConfigSignature(input.source),
  importMetadataJson: input.importMetadataJson ?? null,
  importMetadataHash: input.importMetadataHash ?? null,
  snapshotHash: input.snapshotHash ?? null,
  createdAt: input.source.createdAt,
  updatedAt: input.source.updatedAt,
});
