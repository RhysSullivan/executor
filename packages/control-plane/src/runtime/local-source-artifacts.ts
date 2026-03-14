import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";

import {
  SourceIdSchema,
  SourceRecipeIdSchema,
  StoredSourceRecipeDocumentRecordSchema,
  StoredSourceRecipeOperationRecordSchema,
  StoredSourceRecipeRevisionRecordSchema,
  StoredSourceRecipeSchemaBundleRecordSchema,
  TimestampMsSchema,
  type Source,
  type SourceRecipeId,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ResolvedLocalWorkspaceContext } from "./local-config";
import {
  LocalFileSystemError,
  LocalSourceArtifactDecodeError,
  unknownLocalErrorDetails,
} from "./local-errors";
import {
  createSourceRecipeRevisionRecord,
  stableSourceRecipeId,
} from "./source-definitions";
import {
  contentHash,
  type SourceRecipeMaterialization,
} from "./source-recipe-support";

const LOCAL_SOURCE_ARTIFACT_VERSION = 1 as const;

export const LocalSourceArtifactSchema = Schema.Struct({
  version: Schema.Literal(LOCAL_SOURCE_ARTIFACT_VERSION),
  sourceId: SourceIdSchema,
  recipeId: SourceRecipeIdSchema,
  generatedAt: TimestampMsSchema,
  revision: StoredSourceRecipeRevisionRecordSchema,
  documents: Schema.Array(StoredSourceRecipeDocumentRecordSchema),
  schemaBundles: Schema.Array(StoredSourceRecipeSchemaBundleRecordSchema),
  operations: Schema.Array(StoredSourceRecipeOperationRecordSchema),
});

export type LocalSourceArtifact = typeof LocalSourceArtifactSchema.Type;

const decodeLocalSourceArtifact = Schema.decodeUnknownSync(LocalSourceArtifactSchema);

const provideNodeFileSystem = <A, E, R>(
  effect: Effect.Effect<A, E, R | FileSystem.FileSystem>,
): Effect.Effect<A, E, Exclude<R, FileSystem.FileSystem>> =>
  effect.pipe(Effect.provide(NodeFileSystem.layer)) as Effect.Effect<
    A,
    E,
    Exclude<R, FileSystem.FileSystem>
  >;

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
  join(
    input.context.artifactsDirectory,
    "sources",
    `${input.sourceId}.json`,
  );

const canonicalMaterializationHash = (input: {
  materialization: SourceRecipeMaterialization;
}): string => {
  const documents = [...input.materialization.documents]
    .map((document) => ({
      documentKind: document.documentKind,
      documentKey: document.documentKey,
      contentHash: document.contentHash,
    }))
    .sort((left, right) =>
      left.documentKind.localeCompare(right.documentKind)
      || left.documentKey.localeCompare(right.documentKey)
      || left.contentHash.localeCompare(right.contentHash)
    );
  const schemaBundles = [...input.materialization.schemaBundles]
    .map((bundle) => ({
      bundleKind: bundle.bundleKind,
      contentHash: bundle.contentHash,
    }))
    .sort((left, right) =>
      left.bundleKind.localeCompare(right.bundleKind)
      || left.contentHash.localeCompare(right.contentHash)
    );
  const operations = [...input.materialization.operations]
    .map((operation) => ({
      operationKey: operation.operationKey,
      transportKind: operation.transportKind,
      toolId: operation.toolId,
      title: operation.title,
      description: operation.description,
      operationKind: operation.operationKind,
      searchText: operation.searchText,
      inputSchemaJson: operation.inputSchemaJson,
      outputSchemaJson: operation.outputSchemaJson,
      providerKind: operation.providerKind,
      providerDataJson: operation.providerDataJson,
    }))
    .sort((left, right) => left.operationKey.localeCompare(right.operationKey));

  return contentHash(JSON.stringify({
    schemaVersion: 1,
    manifestHash: input.materialization.manifestHash,
    manifestJson: input.materialization.manifestJson,
    documents,
    schemaBundles,
    operations,
  }));
};

const bindRevisionId = <T extends { recipeRevisionId: string }>(
  items: readonly T[],
  recipeRevisionId: string,
): T[] =>
  items.map((item) => ({
    ...item,
    recipeRevisionId,
  }));

export const buildLocalSourceArtifact = (input: {
  source: Source;
  materialization: SourceRecipeMaterialization;
}): LocalSourceArtifact => {
  const recipeId: SourceRecipeId = stableSourceRecipeId(input.source);
  const now = Date.now();
  const revision = createSourceRecipeRevisionRecord({
    source: input.source,
    recipeId,
    revisionNumber: 1,
    manifestJson: input.materialization.manifestJson,
    manifestHash: input.materialization.manifestHash,
    materializationHash: canonicalMaterializationHash({
      materialization: input.materialization,
    }),
  });

  return {
    version: LOCAL_SOURCE_ARTIFACT_VERSION,
    sourceId: input.source.id,
    recipeId,
    generatedAt: now,
    revision,
    documents: bindRevisionId(input.materialization.documents, revision.id),
    schemaBundles: bindRevisionId(input.materialization.schemaBundles, revision.id),
    operations: bindRevisionId(input.materialization.operations, revision.id),
  };
};

export const readLocalSourceArtifact = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): Effect.Effect<
  LocalSourceArtifact | null,
  LocalFileSystemError | LocalSourceArtifactDecodeError
> =>
  provideNodeFileSystem(Effect.gen(function* () {
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
    return yield* Effect.try({
      try: () => decodeLocalSourceArtifact(JSON.parse(content) as unknown),
      catch: (cause) => {
        return new LocalSourceArtifactDecodeError({
          message: `Invalid local source artifact at ${path}: ${unknownLocalErrorDetails(cause)}`,
          path,
          details: unknownLocalErrorDetails(cause),
        });
      },
    });
  }));

export const writeLocalSourceArtifact = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
  artifact: LocalSourceArtifact;
}): Effect.Effect<void, LocalFileSystemError> =>
  provideNodeFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = join(input.context.artifactsDirectory, "sources");
    const path = localSourceArtifactPath(input);
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(directory, "create source artifact directory")),
    );
    yield* fs.writeFileString(path, `${JSON.stringify(input.artifact, null, 2)}\n`).pipe(
      Effect.mapError(mapFileSystemError(path, "write source artifact")),
    );
  }));

export const removeLocalSourceArtifact = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceId: string;
}): Effect.Effect<void, LocalFileSystemError> =>
  provideNodeFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = localSourceArtifactPath(input);
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(mapFileSystemError(path, "check source artifact path")),
    );
    if (!exists) {
      return;
    }
    yield* fs.remove(path).pipe(
      Effect.mapError(mapFileSystemError(path, "remove source artifact")),
    );
  }));
