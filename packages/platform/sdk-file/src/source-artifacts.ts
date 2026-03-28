import { join } from "node:path";
import { FileSystem } from "@effect/platform";

import type { NativeBlob } from "@executor/ir/model";
import * as Effect from "effect/Effect";
import {
  buildLocalSourceArtifact,
  decodeStoredLocalSourceArtifact,
  hydrateLocalSourceArtifactDocuments,
  splitLocalSourceArtifactDocuments,
  type LocalSourceArtifact,
} from "@executor/platform-sdk/runtime";
import type { ResolvedLocalWorkspaceContext } from "./config";
import {
  LocalFileSystemError,
  unknownLocalErrorDetails,
} from "./errors";

const mapFileSystemError = (path: string, action: string) => (cause: unknown) =>
  new LocalFileSystemError({
    message: `Failed to ${action} ${path}: ${unknownLocalErrorDetails(cause)}`,
    action,
    path,
    details: unknownLocalErrorDetails(cause),
  });

const localSourceArtifactPath = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): string =>
  join(input.context.artifactsDirectory, "sources", `${input.sourceId}.json`);

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

export { buildLocalSourceArtifact };
export type { LocalSourceArtifact };

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

    const content = yield* fs.readFileString(path, "utf8").pipe(
      Effect.mapError(mapFileSystemError(path, "read source artifact")),
    );
    const decodedSnapshotArtifact = decodeStoredLocalSourceArtifact(content);
    if (decodedSnapshotArtifact === null) {
      return null;
    }

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

    return Object.keys(rawDocuments).length > 0
      ? hydrateLocalSourceArtifactDocuments({
          artifact: decodedSnapshotArtifact,
          rawDocuments,
        })
      : decodedSnapshotArtifact;
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
    const split = splitLocalSourceArtifactDocuments(input.artifact);

    yield* fs.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(directory, "create source artifact directory")),
    );
    yield* fs.remove(sourceDocumentDirectory, { recursive: true, force: true }).pipe(
      Effect.mapError(
        mapFileSystemError(sourceDocumentDirectory, "remove source document directory"),
      ),
    );
    if (split.rawDocuments.length > 0) {
      yield* fs.makeDirectory(sourceDocumentDirectory, { recursive: true }).pipe(
        Effect.mapError(
          mapFileSystemError(sourceDocumentDirectory, "create source document directory"),
        ),
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
      Effect.mapError(
        mapFileSystemError(sourceDocumentDirectory, "remove source document directory"),
      ),
    );
  });
