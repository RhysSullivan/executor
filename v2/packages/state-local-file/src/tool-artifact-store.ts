import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import {
  ToolArtifactStoreError,
  ToolArtifactStoreService,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import {
  ToolArtifactSchema,
  type SourceId,
  type ToolArtifact,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import type * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as STM from "effect/STM";
import * as TSemaphore from "effect/TSemaphore";

import {
  type PersistenceErrorData,
  toSchemaPersistenceError,
  withNotFoundFallback,
  withPlatformPersistenceError,
} from "./persistence-error";

const ToolArtifactListSchema = Schema.Array(ToolArtifactSchema);
const ToolArtifactListFromJsonSchema = Schema.parseJson(ToolArtifactListSchema);
const decodeArtifactsFromJson = Schema.decodeUnknown(ToolArtifactListFromJsonSchema);
const encodeArtifactsToJson = Schema.encode(ToolArtifactListFromJsonSchema);

export type LocalToolArtifactStoreOptions = {
  rootDir: string;
};

const defaultArtifactsFilePath = (path: Path.Path, rootDir: string): string =>
  path.resolve(rootDir, "tool-artifacts.json");

const makeToolArtifactStoreError = (
  data: PersistenceErrorData,
): ToolArtifactStoreError => new ToolArtifactStoreError(data);

const mapPlatformToolArtifactStoreError = withPlatformPersistenceError(
  makeToolArtifactStoreError,
);

const toSchemaToolArtifactStoreError = (
  operation: string,
  filePath: string,
  cause: ParseResult.ParseError,
): ToolArtifactStoreError =>
  toSchemaPersistenceError(
    makeToolArtifactStoreError,
    operation,
    filePath,
    "Invalid persisted tool artifact payload",
    cause,
  );

const artifactStoreKey = (artifact: ToolArtifact): string =>
  `${artifact.workspaceId}:${artifact.sourceId}`;

const dedupeArtifacts = (artifacts: ReadonlyArray<ToolArtifact>): Array<ToolArtifact> => {
  const byKey = new Map<string, ToolArtifact>();
  for (const artifact of artifacts) {
    byKey.set(artifactStoreKey(artifact), artifact);
  }
  return Array.from(byKey.values());
};

const readArtifacts = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<Array<ToolArtifact>, ToolArtifactStoreError> =>
  pipe(
    fileSystem.readFileString(filePath),
    withNotFoundFallback("[]"),
    mapPlatformToolArtifactStoreError("read", filePath),
    Effect.flatMap((rawJson) =>
      pipe(
        decodeArtifactsFromJson(rawJson.trim().length === 0 ? "[]" : rawJson),
        Effect.map((artifacts) => dedupeArtifacts(Array.from(artifacts))),
        Effect.mapError((cause) =>
          toSchemaToolArtifactStoreError("decode", filePath, cause),
        ),
      ),
    ),
  );

const writeArtifacts = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  filePath: string,
  artifacts: Array<ToolArtifact>,
): Effect.Effect<void, ToolArtifactStoreError> => {
  const directoryPath = path.dirname(filePath);

  return pipe(
    fileSystem.makeDirectory(directoryPath, { recursive: true }),
    mapPlatformToolArtifactStoreError("mkdir", directoryPath),
    Effect.flatMap(() =>
      pipe(
        encodeArtifactsToJson(artifacts),
        Effect.mapError((cause) =>
          toSchemaToolArtifactStoreError("encode", filePath, cause),
        ),
      ),
    ),
    Effect.flatMap((payload) =>
      pipe(
        fileSystem.makeTempFile({
          directory: directoryPath,
          prefix: `${path.basename(filePath)}.tmp-`,
        }),
        mapPlatformToolArtifactStoreError("makeTempFile", directoryPath),
        Effect.flatMap((tempPath) =>
          pipe(
            fileSystem.writeFileString(tempPath, payload),
            mapPlatformToolArtifactStoreError("write", tempPath),
            Effect.flatMap(() =>
              pipe(
                fileSystem.rename(tempPath, filePath),
                mapPlatformToolArtifactStoreError("rename", filePath),
              ),
            ),
          ),
        ),
      ),
    ),
  );
};

export const makeLocalToolArtifactStore = (
  options: LocalToolArtifactStoreOptions,
): Effect.Effect<ToolArtifactStore, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const writeSemaphore = yield* STM.commit(TSemaphore.make(1));
    const filePath = defaultArtifactsFilePath(path, options.rootDir);

    return {
      getBySource: (workspaceId: WorkspaceId, sourceId: SourceId) =>
        pipe(
          readArtifacts(fileSystem, filePath),
          Effect.map((artifacts) =>
            Option.fromNullable(
              artifacts.find(
                (artifact) =>
                  artifact.workspaceId === workspaceId && artifact.sourceId === sourceId,
              ),
            ),
          ),
        ),

      upsert: (artifact: ToolArtifact) =>
        pipe(
          readArtifacts(fileSystem, filePath),
          Effect.map((artifacts) => {
            const byKey = new Map<string, ToolArtifact>(
              artifacts.map((currentArtifact) => [
                artifactStoreKey(currentArtifact),
                currentArtifact,
              ]),
            );
            byKey.set(artifactStoreKey(artifact), artifact);
            return Array.from(byKey.values());
          }),
          Effect.flatMap((nextArtifacts) =>
            writeArtifacts(fileSystem, path, filePath, nextArtifacts),
          ),
          TSemaphore.withPermit(writeSemaphore),
        ),
    };
  });

export const LocalToolArtifactStoreLive = (
  options: LocalToolArtifactStoreOptions,
): Layer.Layer<
  ToolArtifactStoreService,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(ToolArtifactStoreService, makeLocalToolArtifactStore(options));

