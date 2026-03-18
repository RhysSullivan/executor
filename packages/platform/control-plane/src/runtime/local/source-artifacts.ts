import { join } from "node:path";
import { FileSystem } from "@effect/platform";

import {
  SourceIdSchema,
  SourceCatalogIdSchema,
  StoredSourceCatalogRevisionRecordSchema,
  TimestampMsSchema,
  type Source,
  type SourceCatalogId,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { decodeCatalogSnapshotV1 } from "@executor/ir/catalog";
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
import type { ResolvedLocalWorkspaceContext } from "./config";
import {
  LocalFileSystemError,
  unknownLocalErrorDetails,
} from "./errors";
import {
  createSourceCatalogRevisionRecord,
  stableSourceCatalogId,
} from "../sources/source-definitions";
const LEGACY_LOCAL_SOURCE_ARTIFACT_VERSION = 3 as const;
const LOCAL_SOURCE_ARTIFACT_VERSION = 4 as const;

const LegacyLocalSourceArtifactSchema = Schema.Struct({
  version: Schema.Literal(LEGACY_LOCAL_SOURCE_ARTIFACT_VERSION),
  sourceId: SourceIdSchema,
  catalogId: SourceCatalogIdSchema,
  generatedAt: TimestampMsSchema,
  revision: StoredSourceCatalogRevisionRecordSchema,
  snapshot: CatalogSnapshotV1Schema,
});

export const LocalSourceArtifactSchema = Schema.Struct({
  version: Schema.Literal(LOCAL_SOURCE_ARTIFACT_VERSION),
  sourceId: SourceIdSchema,
  catalogId: SourceCatalogIdSchema,
  generatedAt: TimestampMsSchema,
  revision: StoredSourceCatalogRevisionRecordSchema,
  snapshot: CatalogSnapshotV1Schema,
});

export type LocalSourceArtifact = typeof LocalSourceArtifactSchema.Type;
type LegacyLocalSourceArtifact = typeof LegacyLocalSourceArtifactSchema.Type;

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

const mapFileSystemError = (path: string, action: string) => (cause: unknown) =>
  new LocalFileSystemError({
    message: `Failed to ${action} ${path}: ${unknownLocalErrorDetails(cause)}`,
    action,
    path,
    details: unknownLocalErrorDetails(cause),
  });

const mutableRecord = <K extends string, V>(value: Readonly<Record<K, V>>): Record<K, V> =>
  value as Record<K, V>;

const localSourceArtifactPath = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): string =>
  join(
    input.context.artifactsDirectory,
    "sources",
    `${input.sourceId}.json`,
  );

const localSourceDocumentDirectory = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): string =>
  join(input.context.artifactsDirectory, "sources", input.sourceId, "documents");

const localSourceDocumentPath = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
  documentId: string;
}): string =>
  join(localSourceDocumentDirectory(input), `${input.documentId}.txt`);

const splitArtifactSourceDocuments = (artifact: LocalSourceArtifact): {
  artifact: LocalSourceArtifact;
  rawDocuments: ReadonlyArray<{
    documentId: string;
    blob: NativeBlob;
    content: string;
  }>;
} => {
  const nextArtifact = structuredClone(artifact);
  const rawDocuments: Array<{
    documentId: string;
    blob: NativeBlob;
    content: string;
  }> = [];

  for (const [documentId, document] of Object.entries(nextArtifact.snapshot.catalog.documents)) {
    const mutableDocument = document as SourceDocument & { native?: NativeBlob[] };
    const sourceDocumentBlob = document.native?.find((blob) =>
      blob.kind === "source_document" && typeof blob.value === "string"
    );
    if (!sourceDocumentBlob || typeof sourceDocumentBlob.value !== "string") {
      continue;
    }

    rawDocuments.push({
      documentId,
      blob: sourceDocumentBlob,
      content: sourceDocumentBlob.value,
    });

    const remainingBlobs = (document.native ?? []).filter((blob) => blob !== sourceDocumentBlob);
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

const hydrateArtifactSourceDocuments = (input: {
  artifact: LocalSourceArtifact;
  rawDocuments: Readonly<Record<string, NativeBlob>>;
}): LocalSourceArtifact => {
  const nextArtifact = structuredClone(input.artifact);
  const mutableDocuments = mutableRecord(nextArtifact.snapshot.catalog.documents);

  for (const [documentId, rawDocument] of Object.entries(input.rawDocuments)) {
    const document = mutableDocuments[documentId as keyof typeof mutableDocuments] as (SourceDocument & { native?: NativeBlob[] }) | undefined;
    if (!document) {
      continue;
    }

    const remainingBlobs = (document.native ?? []).filter((blob) => blob.kind !== "source_document");
    document.native = [rawDocument, ...remainingBlobs];
  }

  return nextArtifact;
};

const snapshotHash = (snapshot: CatalogSnapshotV1): string =>
  contentHash(JSON.stringify(snapshot));

const importMetadataHash = (snapshot: { import: SourceCatalogSyncResult["importMetadata"] }): string =>
  contentHash(JSON.stringify(snapshot.import));

const decodeCatalogSnapshotV1Option = (
  snapshot: unknown,
): CatalogSnapshotV1 | null => {
  try {
    return decodeCatalogSnapshotV1(snapshot);
  } catch {
    return null;
  }
};

export const buildLocalSourceArtifact = (input: {
  source: Source;
  syncResult: SourceCatalogSyncResult;
}): LocalSourceArtifact => {
  const catalogId: SourceCatalogId = stableSourceCatalogId(input.source);
  const generatedAt = Date.now();
  const snapshot = snapshotFromSourceCatalogSyncResult(input.syncResult);
  const importHash = importMetadataHash(snapshot);
  const hash = snapshotHash(snapshot);
  const revision = createSourceCatalogRevisionRecord({
    source: input.source,
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

export const readLocalSourceArtifact = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): Effect.Effect<
  LocalSourceArtifact | null,
  LocalFileSystemError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = localSourceArtifactPath(input);
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(mapFileSystemError(path, "check source artifact path")),
    );
    if (!exists) {
      return null;
    }

    const readPath = path;
    const content = yield* fs.readFileString(readPath, "utf8").pipe(
      Effect.mapError(mapFileSystemError(readPath, "read source artifact")),
    );

    const decodedArtifact = decodeReadableLocalSourceArtifactOption(content);
    if (Option.isNone(decodedArtifact)) {
      return null;
    }

    const artifact = normalizeLocalSourceArtifact(decodedArtifact.value);
    const snapshot = decodeCatalogSnapshotV1Option(artifact.snapshot);
    if (snapshot === null) {
      return null;
    }

    const decodedSnapshotArtifact: LocalSourceArtifact = {
      ...artifact,
      snapshot,
    };

    const rawDocuments: Record<string, NativeBlob> = {};
    for (const documentId of Object.keys(decodedSnapshotArtifact.snapshot.catalog.documents)) {
      const sourceDocumentPath = localSourceDocumentPath({
        context: input.context,
        sourceId: input.sourceId,
        documentId,
      });
      const sourceDocumentExists = yield* fs.exists(sourceDocumentPath).pipe(
        Effect.mapError(mapFileSystemError(sourceDocumentPath, "check source document path")),
      );
      if (!sourceDocumentExists) {
        continue;
      }

      const sourceContent = yield* fs.readFileString(sourceDocumentPath, "utf8").pipe(
        Effect.mapError(mapFileSystemError(sourceDocumentPath, "read source document")),
      );
      rawDocuments[documentId] = {
        sourceKind: decodedSnapshotArtifact.snapshot.import.sourceKind,
        kind: "source_document",
        value: sourceContent,
      } satisfies NativeBlob;
    }

    const hydratedArtifact = Object.keys(rawDocuments).length > 0
      ? hydrateArtifactSourceDocuments({
          artifact: decodedSnapshotArtifact,
          rawDocuments,
        })
      : decodedSnapshotArtifact;

    return {
      ...hydratedArtifact,
      snapshot: hydratedArtifact.snapshot,
    };
  });

export const writeLocalSourceArtifact = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
  artifact: LocalSourceArtifact;
}): Effect.Effect<void, LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = join(input.context.artifactsDirectory, "sources");
    const path = localSourceArtifactPath(input);
    const sourceDocumentDirectory = localSourceDocumentDirectory(input);
    const split = splitArtifactSourceDocuments(input.artifact);
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(directory, "create source artifact directory")),
    );
    yield* fs.remove(sourceDocumentDirectory, { recursive: true, force: true }).pipe(
      Effect.mapError(mapFileSystemError(sourceDocumentDirectory, "remove source document directory")),
    );
    if (split.rawDocuments.length > 0) {
      yield* fs.makeDirectory(sourceDocumentDirectory, { recursive: true }).pipe(
        Effect.mapError(mapFileSystemError(sourceDocumentDirectory, "create source document directory")),
      );
      for (const rawDocument of split.rawDocuments) {
        const sourceDocumentPath = localSourceDocumentPath({
          context: input.context,
          sourceId: input.sourceId,
          documentId: rawDocument.documentId,
        });
        yield* fs.writeFileString(sourceDocumentPath, rawDocument.content).pipe(
          Effect.mapError(mapFileSystemError(sourceDocumentPath, "write source document")),
        );
      }
    }
    yield* fs.writeFileString(path, `${JSON.stringify(split.artifact)}\n`).pipe(
      Effect.mapError(mapFileSystemError(path, "write source artifact")),
    );
  });

export const removeLocalSourceArtifact = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): Effect.Effect<void, LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = localSourceArtifactPath(input);
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(mapFileSystemError(path, "check source artifact path")),
    );
    if (exists) {
      yield* fs.remove(path).pipe(
        Effect.mapError(mapFileSystemError(path, "remove source artifact")),
      );
    }
    const sourceDocumentDirectory = localSourceDocumentDirectory(input);
    yield* fs.remove(sourceDocumentDirectory, { recursive: true, force: true }).pipe(
      Effect.mapError(mapFileSystemError(sourceDocumentDirectory, "remove source document directory")),
    );
  });
