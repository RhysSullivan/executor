import {
  SourceIdSchema,
  SourceCatalogIdSchema,
  StoredSourceCatalogRevisionRecordSchema,
  TimestampMsSchema,
  type Source,
  type SourceCatalogId,
} from "#schema";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  decodeCatalogSnapshotV1,
} from "@executor/ir/catalog";
import {
  CatalogSnapshotV1Schema,
  type CatalogSnapshotV1,
  type NativeBlob,
  type SourceDocument,
} from "@executor/ir/model";
import {
  contentHash,
  snapshotFromSourceCatalogSyncResult,
  type SourceCatalogSyncResult,
} from "@executor/source-core";
import {
  createSourceCatalogRevisionRecord,
  stableSourceCatalogId,
} from "./sources/source-definitions";
import type {
  ExecutorSdkPluginRegistry,
} from "../plugins";

const LEGACY_LOCAL_SOURCE_ARTIFACT_VERSION = 3 as const;
const LOCAL_SOURCE_ARTIFACT_VERSION = 4 as const;

export const LocalSourceArtifactSchema = Schema.Struct({
  version: Schema.Literal(LOCAL_SOURCE_ARTIFACT_VERSION),
  sourceId: SourceIdSchema,
  catalogId: SourceCatalogIdSchema,
  generatedAt: TimestampMsSchema,
  revision: StoredSourceCatalogRevisionRecordSchema,
  snapshot: CatalogSnapshotV1Schema,
});

export type LocalSourceArtifact = typeof LocalSourceArtifactSchema.Type;

const ReadableLegacyLocalSourceArtifactSchema = Schema.Struct({
  version: Schema.Literal(LEGACY_LOCAL_SOURCE_ARTIFACT_VERSION),
  sourceId: SourceIdSchema,
  catalogId: SourceCatalogIdSchema,
  generatedAt: TimestampMsSchema,
  revision: StoredSourceCatalogRevisionRecordSchema,
  snapshot: Schema.Unknown,
});

const ReadableLocalSourceArtifactSchema = Schema.Struct({
  version: Schema.Literal(LOCAL_SOURCE_ARTIFACT_VERSION),
  sourceId: SourceIdSchema,
  catalogId: SourceCatalogIdSchema,
  generatedAt: TimestampMsSchema,
  revision: StoredSourceCatalogRevisionRecordSchema,
  snapshot: Schema.Unknown,
});

type ReadableLegacyLocalSourceArtifact =
  typeof ReadableLegacyLocalSourceArtifactSchema.Type;
type ReadableLocalSourceArtifact =
  typeof ReadableLocalSourceArtifactSchema.Type;

const decodeReadableLocalSourceArtifactOption = Schema.decodeUnknownOption(
  Schema.parseJson(
    Schema.Union(
      ReadableLocalSourceArtifactSchema,
      ReadableLegacyLocalSourceArtifactSchema,
    ),
  ),
);

const normalizeLocalSourceArtifact = (
  artifact: ReadableLocalSourceArtifact | ReadableLegacyLocalSourceArtifact,
): Omit<LocalSourceArtifact, "snapshot"> & { snapshot: unknown } =>
  artifact.version === LOCAL_SOURCE_ARTIFACT_VERSION
    ? artifact
    : {
        ...artifact,
        version: LOCAL_SOURCE_ARTIFACT_VERSION,
      };

const mutableRecord = <K extends string, V>(
  value: Readonly<Record<K, V>>,
): Record<K, V> => value as Record<K, V>;

export type SourceArtifactDocumentContent = {
  documentId: string;
  blob: NativeBlob;
  content: string;
};

export const splitLocalSourceArtifactDocuments = (
  artifact: LocalSourceArtifact,
): {
  artifact: LocalSourceArtifact;
  rawDocuments: readonly SourceArtifactDocumentContent[];
} => {
  const nextArtifact = structuredClone(artifact);
  const rawDocuments: Array<SourceArtifactDocumentContent> = [];

  for (const [documentId, document] of Object.entries(
    nextArtifact.snapshot.catalog.documents,
  )) {
    const mutableDocument = document as SourceDocument & { native?: NativeBlob[] };
    const sourceDocumentBlob = document.native?.find(
      (blob) => blob.kind === "source_document" && typeof blob.value === "string",
    );
    if (!sourceDocumentBlob || typeof sourceDocumentBlob.value !== "string") {
      continue;
    }

    rawDocuments.push({
      documentId,
      blob: sourceDocumentBlob,
      content: sourceDocumentBlob.value,
    });

    const remainingBlobs = (document.native ?? []).filter(
      (blob) => blob !== sourceDocumentBlob,
    );
    if (remainingBlobs.length > 0) {
      mutableDocument.native = remainingBlobs;
    } else {
      delete mutableDocument.native;
    }
  }

  return {
    artifact: nextArtifact,
    rawDocuments,
  };
};

export const hydrateLocalSourceArtifactDocuments = (input: {
  artifact: LocalSourceArtifact;
  rawDocuments: Readonly<Record<string, NativeBlob>>;
}): LocalSourceArtifact => {
  const nextArtifact = structuredClone(input.artifact);
  const mutableDocuments = mutableRecord(nextArtifact.snapshot.catalog.documents);

  for (const [documentId, rawDocument] of Object.entries(input.rawDocuments)) {
    const document = mutableDocuments[
      documentId as keyof typeof mutableDocuments
    ] as (SourceDocument & { native?: NativeBlob[] }) | undefined;
    if (!document) {
      continue;
    }

    const remainingBlobs = (document.native ?? []).filter(
      (blob) => blob.kind !== "source_document",
    );
    document.native = [rawDocument, ...remainingBlobs];
  }

  return nextArtifact;
};

const snapshotHash = (snapshot: CatalogSnapshotV1): string =>
  contentHash(JSON.stringify(snapshot));

const importMetadataHash = (snapshot: {
  import: SourceCatalogSyncResult["importMetadata"];
}): string => contentHash(JSON.stringify(snapshot.import));

const decodeCatalogSnapshotV1Option = (
  snapshot: unknown,
): CatalogSnapshotV1 | null => {
  try {
    return decodeCatalogSnapshotV1(snapshot);
  } catch {
    return null;
  }
};

export const decodeStoredLocalSourceArtifact = (
  content: string,
): LocalSourceArtifact | null => {
  const decodedArtifact = decodeReadableLocalSourceArtifactOption(content);
  if (Option.isNone(decodedArtifact)) {
    return null;
  }

  const artifact = normalizeLocalSourceArtifact(decodedArtifact.value);
  const snapshot = decodeCatalogSnapshotV1Option(artifact.snapshot);
  if (snapshot === null) {
    return null;
  }

  return {
    ...artifact,
    snapshot,
  };
};

export const buildLocalSourceArtifact = (input: {
  source: Source;
  syncResult: SourceCatalogSyncResult;
  pluginRegistry?: ExecutorSdkPluginRegistry;
}): LocalSourceArtifact => {
  const catalogId: SourceCatalogId = stableSourceCatalogId(
    input.source,
    input.pluginRegistry,
  );
  const generatedAt = Date.now();
  const snapshot = snapshotFromSourceCatalogSyncResult(input.syncResult);
  const importHash = importMetadataHash(snapshot);
  const hash = snapshotHash(snapshot);
  const revision = createSourceCatalogRevisionRecord({
    source: input.source,
    pluginRegistry: input.pluginRegistry,
    catalogId,
    revisionNumber: 1,
    importMetadataJson: JSON.stringify(snapshot.import),
    importMetadataHash: importHash,
    snapshotHash: hash,
  });

  return {
    version: LOCAL_SOURCE_ARTIFACT_VERSION,
    sourceId: input.source.id,
    catalogId,
    generatedAt,
    revision,
    snapshot,
  };
};
