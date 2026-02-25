import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ToolArtifactStore } from "@executor-v2/persistence-ports";
import {
  SourceIdSchema,
  ToolArtifactSchema,
  WorkspaceIdSchema,
  type SourceId,
  type ToolArtifact,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class LocalPersistenceError extends Schema.TaggedError<LocalPersistenceError>()(
  "LocalPersistenceError",
  {
    operation: Schema.String,
    filePath: Schema.String,
    message: Schema.String,
  },
) {}

const ToolArtifactListSchema = Schema.Array(ToolArtifactSchema);

const decodeArtifacts = Schema.decodeUnknownSync(ToolArtifactListSchema);
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceIdSchema);
const decodeSourceId = Schema.decodeUnknownSync(SourceIdSchema);

export type LocalToolArtifactStoreOptions = {
  rootDir: string;
};

const defaultArtifactsFilePath = (rootDir: string): string =>
  resolve(rootDir, "tool-artifacts.json");

const toLocalPersistenceError = (
  operation: string,
  filePath: string,
  cause: unknown,
): LocalPersistenceError =>
  new LocalPersistenceError({
    operation,
    filePath,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const readArtifacts = (filePath: string): Effect.Effect<Array<ToolArtifact>, LocalPersistenceError> =>
  pipe(
    Effect.tryPromise({
      try: () => readFile(filePath, "utf8"),
      catch: (cause) => toLocalPersistenceError("read", filePath, cause),
    }),
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => decodeArtifacts(JSON.parse(raw)),
        catch: (cause) => toLocalPersistenceError("decode", filePath, cause),
      }),
    ),
    Effect.catchTag("LocalPersistenceError", (error) =>
      error.operation === "read" && error.message.includes("ENOENT")
        ? Effect.succeed([])
        : Effect.fail(error),
    ),
  );

const writeArtifacts = (
  filePath: string,
  artifacts: Array<ToolArtifact>,
): Effect.Effect<void, LocalPersistenceError> => {
  const tempPath = `${filePath}.tmp`;
  return pipe(
    Effect.tryPromise({
      try: () => mkdir(dirname(filePath), { recursive: true }),
      catch: (cause) => toLocalPersistenceError("mkdir", filePath, cause),
    }),
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: () => writeFile(tempPath, JSON.stringify(artifacts, null, 2), "utf8"),
        catch: (cause) => toLocalPersistenceError("write", tempPath, cause),
      }),
    ),
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: () => rename(tempPath, filePath),
        catch: (cause) => toLocalPersistenceError("rename", filePath, cause),
      }),
    ),
  );
};

export const makeLocalToolArtifactStore = (
  options: LocalToolArtifactStoreOptions,
): ToolArtifactStore => {
  const filePath = defaultArtifactsFilePath(options.rootDir);

  return {
    getBySource: (workspaceId: WorkspaceId, sourceId: SourceId) =>
      pipe(
        readArtifacts(filePath),
        Effect.map((artifacts) => {
          const match = artifacts.find(
            (artifact) =>
              artifact.workspaceId === workspaceId && artifact.sourceId === sourceId,
          );
          return Option.fromNullable(match);
        }),
      ),

    upsert: (artifact: ToolArtifact) =>
      pipe(
        readArtifacts(filePath),
        Effect.map((artifacts) => {
          const next = [...artifacts];
          const index = next.findIndex(
            (current) =>
              current.workspaceId === artifact.workspaceId &&
              current.sourceId === artifact.sourceId,
          );

          if (index >= 0) {
            next[index] = artifact;
          } else {
            next.push(artifact);
          }

          return next;
        }),
        Effect.flatMap((next) => writeArtifacts(filePath, next)),
      ),
  };
};

export const makeWorkspaceId = (value: string): WorkspaceId => decodeWorkspaceId(value);
export const makeSourceId = (value: string): SourceId => decodeSourceId(value);
