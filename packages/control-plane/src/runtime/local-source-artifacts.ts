import { join } from "node:path";
import { gunzipSync } from "node:zlib";
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
import * as Schema from "effect/Schema";

import {
  CatalogSnapshotV1Schema,
  type NativeBlob,
  type ShapeNode,
  type SourceDocument,
} from "../ir/model";
import type { SourceCatalogSyncResult } from "./source-catalog-support";
import type { ResolvedLocalWorkspaceContext } from "./local-config";
import {
  LocalFileSystemError,
  LocalSourceArtifactDecodeError,
  unknownLocalErrorDetails,
} from "./local-errors";
import {
  createSourceCatalogRevisionRecord,
  stableSourceCatalogId,
} from "./source-definitions";
import { contentHash } from "./source-catalog-support";

const LOCAL_SOURCE_ARTIFACT_VERSION = 2 as const;

export const LocalSourceArtifactSchema = Schema.Struct({
  version: Schema.Literal(LOCAL_SOURCE_ARTIFACT_VERSION),
  sourceId: SourceIdSchema,
  catalogId: SourceCatalogIdSchema,
  generatedAt: TimestampMsSchema,
  revision: StoredSourceCatalogRevisionRecordSchema,
  snapshot: CatalogSnapshotV1Schema,
});

export type LocalSourceArtifact = typeof LocalSourceArtifactSchema.Type;

const decodeLocalSourceArtifact = Schema.decodeUnknownSync(LocalSourceArtifactSchema);

const mapFileSystemError = (path: string, action: string) => (cause: unknown) =>
  new LocalFileSystemError({
    message: `Failed to ${action} ${path}: ${unknownLocalErrorDetails(cause)}`,
    action,
    path,
    details: unknownLocalErrorDetails(cause),
  });

const mutableRecord = <K extends string, V>(value: Readonly<Record<K, V>>): Record<K, V> =>
  value as Record<K, V>;

const clearProvenance = (value: unknown): void => {
  (value as { provenance: Array<unknown> }).provenance = [];
};

const localSourceArtifactPath = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): string =>
  join(
    input.context.artifactsDirectory,
    "sources",
    `${input.sourceId}.json`,
  );

const legacyLocalSourceArtifactPath = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): string =>
  join(
    input.context.artifactsDirectory,
    "sources",
    `${input.sourceId}.json.gz`,
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

const stripShapeFieldDocs = (node: ShapeNode): void => {
  switch (node.type) {
    case "object":
    case "graphqlInterface":
      for (const field of Object.values(node.fields)) {
        delete (field as { docs?: unknown }).docs;
      }
      return;
    default:
      return;
  }
};

const stripRuntimeMetadata = (artifact: LocalSourceArtifact): LocalSourceArtifact => {
  const nextArtifact = structuredClone(artifact);

  for (const document of Object.values(nextArtifact.snapshot.catalog.documents)) {
    delete (document as { provenance?: unknown }).provenance;
    delete (document as { docs?: unknown }).docs;
    delete (document as { native?: unknown }).native;
  }

  for (const resource of Object.values(nextArtifact.snapshot.catalog.resources)) {
    clearProvenance(resource as unknown);
    delete (resource as { docs?: unknown }).docs;
    delete (resource as { native?: unknown }).native;
  }

  for (const scope of Object.values(nextArtifact.snapshot.catalog.scopes)) {
    clearProvenance(scope as unknown);
    delete (scope as { docs?: unknown }).docs;
    delete (scope as { native?: unknown }).native;
  }

  for (const capability of Object.values(nextArtifact.snapshot.catalog.capabilities)) {
    clearProvenance(capability as unknown);
    delete (capability as { native?: unknown }).native;
    delete (capability as { exampleIds?: unknown }).exampleIds;
  }

  for (const executable of Object.values(nextArtifact.snapshot.catalog.executables)) {
    clearProvenance(executable as unknown);
    if (Array.isArray((executable as { native?: NativeBlob[] }).native)) {
      const keptNative = ((executable as { native?: NativeBlob[] }).native ?? []).filter((blob) =>
        blob.kind === "google_discovery_provider_data"
      );
      if (keptNative.length > 0) {
        (executable as { native?: NativeBlob[] }).native = keptNative;
      } else {
        delete (executable as { native?: unknown }).native;
      }
    }
  }

  for (const responseSet of Object.values(nextArtifact.snapshot.catalog.responseSets)) {
    clearProvenance(responseSet as unknown);
    delete (responseSet as { native?: unknown }).native;
  }

  for (const diagnostic of Object.values(nextArtifact.snapshot.catalog.diagnostics)) {
    delete (diagnostic as { provenance?: unknown }).provenance;
  }

  const mutableSymbols = mutableRecord(nextArtifact.snapshot.catalog.symbols);
  for (const [symbolId, symbol] of Object.entries(mutableSymbols)) {
    if (symbol.kind === "example") {
      delete mutableSymbols[symbolId as keyof typeof mutableSymbols];
      continue;
    }

    clearProvenance(symbol as unknown);
    delete (symbol as { docs?: unknown }).docs;
    delete (symbol as { diagnosticIds?: unknown }).diagnosticIds;
    delete (symbol as { native?: unknown }).native;
    delete (symbol as { deprecated?: unknown }).deprecated;

    switch (symbol.kind) {
      case "shape":
        stripShapeFieldDocs(symbol.node);
        break;
      case "parameter":
      case "header":
      case "response":
        delete (symbol as { exampleIds?: unknown }).exampleIds;
        if ("content" in symbol && Array.isArray(symbol.content)) {
          for (const content of symbol.content) {
            delete (content as { exampleIds?: unknown }).exampleIds;
          }
        }
        break;
      case "requestBody":
        for (const content of symbol.contents) {
          delete (content as { exampleIds?: unknown }).exampleIds;
        }
        break;
    }
  }

  mutableRecord(nextArtifact.snapshot.catalog).diagnostics = {};

  return nextArtifact;
};

const snapshotHash = (snapshot: SourceCatalogSyncResult["snapshot"]): string =>
  contentHash(JSON.stringify(snapshot));

export const buildLocalSourceArtifact = (input: {
  source: Source;
  syncResult: SourceCatalogSyncResult;
}): LocalSourceArtifact => {
  const catalogId: SourceCatalogId = stableSourceCatalogId(input.source);
  const generatedAt = Date.now();
  const hash = snapshotHash(input.syncResult.snapshot);
  const revision = createSourceCatalogRevisionRecord({
    source: input.source,
    catalogId,
    revisionNumber: 1,
    importMetadataJson: JSON.stringify(input.syncResult.snapshot.import),
    importMetadataHash: hash,
    snapshotHash: hash,
  });

  return {
    version: LOCAL_SOURCE_ARTIFACT_VERSION,
    sourceId: input.source.id,
    catalogId,
    generatedAt,
    revision,
    snapshot: input.syncResult.snapshot,
  };
};

export const readLocalSourceArtifact = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): Effect.Effect<
  LocalSourceArtifact | null,
  LocalFileSystemError | LocalSourceArtifactDecodeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = localSourceArtifactPath(input);
    const legacyPath = legacyLocalSourceArtifactPath(input);
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(mapFileSystemError(path, "check source artifact path")),
    );
    const legacyExists = exists
      ? false
      : yield* fs.exists(legacyPath).pipe(
          Effect.mapError(mapFileSystemError(legacyPath, "check legacy source artifact path")),
        );
    if (!exists && !legacyExists) {
      return null;
    }

    const readPath = exists ? path : legacyPath;
    const content = exists
      ? yield* fs.readFileString(readPath, "utf8").pipe(
          Effect.mapError(mapFileSystemError(readPath, "read source artifact")),
        )
      : yield* fs.readFile(readPath).pipe(
          Effect.mapError(mapFileSystemError(readPath, "read source artifact")),
          Effect.flatMap((bytes) =>
            Effect.try({
              try: () => new TextDecoder().decode(gunzipSync(bytes)),
              catch: (cause) =>
                new LocalSourceArtifactDecodeError({
                  message: `Invalid compressed local source artifact at ${readPath}: ${unknownLocalErrorDetails(cause)}`,
                  path: readPath,
                  details: unknownLocalErrorDetails(cause),
              }),
            })
          ),
        );

    const artifact = yield* Effect.try({
      try: () => decodeLocalSourceArtifact(JSON.parse(content) as unknown),
      catch: (cause) =>
        new LocalSourceArtifactDecodeError({
          message: `Invalid local source artifact at ${readPath}: ${unknownLocalErrorDetails(cause)}`,
          path: readPath,
          details: unknownLocalErrorDetails(cause),
        }),
    });

    const rawDocuments: Record<string, NativeBlob> = {};
    for (const documentId of Object.keys(artifact.snapshot.catalog.documents)) {
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
        sourceKind: artifact.snapshot.import.sourceKind,
        kind: "source_document",
        value: sourceContent,
      } satisfies NativeBlob;
    }

    return Object.keys(rawDocuments).length > 0
      ? hydrateArtifactSourceDocuments({
          artifact,
          rawDocuments,
        })
      : artifact;
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
    const legacyPath = legacyLocalSourceArtifactPath(input);
    const sourceDocumentDirectory = localSourceDocumentDirectory(input);
    const split = splitArtifactSourceDocuments(input.artifact);
    const runtimeArtifact = stripRuntimeMetadata(split.artifact);
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
    yield* fs.writeFileString(path, `${JSON.stringify(runtimeArtifact)}\n`).pipe(
      Effect.mapError(mapFileSystemError(path, "write source artifact")),
    );
    const legacyExists = yield* fs.exists(legacyPath).pipe(
      Effect.mapError(mapFileSystemError(legacyPath, "check legacy source artifact path")),
    );
    if (legacyExists) {
      yield* fs.remove(legacyPath).pipe(
        Effect.mapError(mapFileSystemError(legacyPath, "remove legacy source artifact")),
      );
    }
  });

export const removeLocalSourceArtifact = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): Effect.Effect<void, LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const path of [localSourceArtifactPath(input), legacyLocalSourceArtifactPath(input)]) {
      const exists = yield* fs.exists(path).pipe(
        Effect.mapError(mapFileSystemError(path, "check source artifact path")),
      );
      if (!exists) {
        continue;
      }
      yield* fs.remove(path).pipe(
        Effect.mapError(mapFileSystemError(path, "remove source artifact")),
      );
    }
    const sourceDocumentDirectory = localSourceDocumentDirectory(input);
    yield* fs.remove(sourceDocumentDirectory, { recursive: true, force: true }).pipe(
      Effect.mapError(mapFileSystemError(sourceDocumentDirectory, "remove source document directory")),
    );
  });
