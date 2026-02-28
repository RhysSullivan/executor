import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import {
  SourceStoreError,
  SourceStoreService,
  type SourceStore,
} from "@executor-v2/persistence-ports";
import {
  SourceSchema,
  type Source,
  type SourceId,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import * as STM from "effect/STM";
import * as TSemaphore from "effect/TSemaphore";

import {
  type PersistenceErrorData,
  toSchemaPersistenceError,
  withNotFoundFallback,
  withPlatformPersistenceError,
} from "./persistence-error";

const SourceListSchema = Schema.Array(SourceSchema);
const SourceListFromJsonSchema = Schema.parseJson(SourceListSchema);
const decodeSourcesFromJson = Schema.decodeUnknown(SourceListFromJsonSchema);
const encodeSourcesToJson = Schema.encode(SourceListFromJsonSchema);

export type LocalSourceStoreOptions = {
  rootDir: string;
  fileName?: string;
};

const defaultSourcesFilePath = (path: Path.Path, options: LocalSourceStoreOptions): string =>
  path.resolve(options.rootDir, options.fileName ?? "sources.json");

const makeSourceStoreError = (data: PersistenceErrorData): SourceStoreError =>
  new SourceStoreError(data);

const mapPlatformSourceStoreError = withPlatformPersistenceError(makeSourceStoreError);

const toSchemaSourceStoreError = (
  operation: string,
  filePath: string,
  cause: ParseResult.ParseError,
): SourceStoreError =>
  toSchemaPersistenceError(
    makeSourceStoreError,
    operation,
    filePath,
    "Invalid persisted source payload",
    cause,
  );

const sourceStoreKey = (source: Source): string => `${source.workspaceId}:${source.id}`;

const dedupeSources = (sources: ReadonlyArray<Source>): Array<Source> => {
  const byKey = new Map<string, Source>();
  for (const source of sources) {
    byKey.set(sourceStoreKey(source), source);
  }
  return Array.from(byKey.values());
};

const sortSources = (sources: ReadonlyArray<Source>): Array<Source> =>
  [...sources].sort((left, right) => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName === rightName) {
      return left.id.localeCompare(right.id);
    }

    return leftName.localeCompare(rightName);
  });

const readSources = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<Array<Source>, SourceStoreError> =>
  pipe(
    fileSystem.readFileString(filePath),
    withNotFoundFallback("[]"),
    mapPlatformSourceStoreError("read", filePath),
    Effect.flatMap((rawJson) =>
      pipe(
        decodeSourcesFromJson(rawJson.trim().length === 0 ? "[]" : rawJson),
        Effect.map((sources) => sortSources(dedupeSources(Array.from(sources)))),
        Effect.mapError((cause) => toSchemaSourceStoreError("decode", filePath, cause)),
      ),
    ),
  );

const writeSources = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  filePath: string,
  sources: ReadonlyArray<Source>,
): Effect.Effect<void, SourceStoreError> => {
  const directoryPath = path.dirname(filePath);

  return pipe(
    fileSystem.makeDirectory(directoryPath, { recursive: true }),
    mapPlatformSourceStoreError("mkdir", directoryPath),
    Effect.flatMap(() =>
      pipe(
        encodeSourcesToJson(sources),
        Effect.mapError((cause) => toSchemaSourceStoreError("encode", filePath, cause)),
      ),
    ),
    Effect.flatMap((payload) =>
      pipe(
        fileSystem.makeTempFile({
          directory: directoryPath,
          prefix: `${path.basename(filePath)}.tmp-`,
        }),
        mapPlatformSourceStoreError("makeTempFile", directoryPath),
        Effect.flatMap((tempPath) =>
          pipe(
            fileSystem.writeFileString(tempPath, payload),
            mapPlatformSourceStoreError("write", tempPath),
            Effect.flatMap(() =>
              pipe(
                fileSystem.rename(tempPath, filePath),
                mapPlatformSourceStoreError("rename", filePath),
              ),
            ),
          ),
        ),
      ),
    ),
  );
};

export const makeLocalSourceStore = (
  options: LocalSourceStoreOptions,
): Effect.Effect<SourceStore, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const writeSemaphore = yield* STM.commit(TSemaphore.make(1));
    const filePath = defaultSourcesFilePath(path, options);

    return {
      getById: (workspaceId: WorkspaceId, sourceId: SourceId) =>
        pipe(
          readSources(fileSystem, filePath),
          Effect.map((sources) =>
            Option.fromNullable(
              sources.find(
                (source) => source.workspaceId === workspaceId && source.id === sourceId,
              ),
            ),
          ),
        ),

      listByWorkspace: (workspaceId: WorkspaceId) =>
        pipe(
          readSources(fileSystem, filePath),
          Effect.map((sources) =>
            sources.filter((source) => source.workspaceId === workspaceId),
          ),
        ),

      upsert: (source: Source) =>
        pipe(
          readSources(fileSystem, filePath),
          Effect.map((sources) => {
            const byKey = new Map<string, Source>(
              sources.map((currentSource) => [sourceStoreKey(currentSource), currentSource]),
            );
            byKey.set(sourceStoreKey(source), source);
            return sortSources(Array.from(byKey.values()));
          }),
          Effect.flatMap((nextSources) => writeSources(fileSystem, path, filePath, nextSources)),
          TSemaphore.withPermit(writeSemaphore),
        ),

      removeById: (workspaceId: WorkspaceId, sourceId: SourceId) =>
        pipe(
          readSources(fileSystem, filePath),
          Effect.flatMap((sources) => {
            const nextSources = sources.filter(
              (source) => !(source.workspaceId === workspaceId && source.id === sourceId),
            );
            const removed = nextSources.length !== sources.length;

            if (!removed) {
              return Effect.succeed(false);
            }

            return pipe(
              writeSources(fileSystem, path, filePath, nextSources),
              Effect.as(true),
            );
          }),
          TSemaphore.withPermit(writeSemaphore),
        ),
    };
  });

export const LocalSourceStoreLive = (
  options: LocalSourceStoreOptions,
): Layer.Layer<SourceStoreService, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(SourceStoreService, makeLocalSourceStore(options));
