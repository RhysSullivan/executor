import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";

import {
  PolicyIdSchema,
  SourceStatusSchema,
  TimestampMsSchema,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ResolvedLocalWorkspaceContext } from "./local-config";
import {
  LocalFileSystemError,
  LocalWorkspaceStateDecodeError,
  unknownLocalErrorDetails,
} from "./local-errors";

const WORKSPACE_STATE_BASENAME = "workspace-state.json";

const LocalWorkspaceSourceStateSchema = Schema.Struct({
  status: SourceStatusSchema,
  lastError: Schema.NullOr(Schema.String),
  sourceHash: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

const LocalWorkspacePolicyStateSchema = Schema.Struct({
  id: PolicyIdSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export const LocalWorkspaceStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  sources: Schema.Record({
    key: Schema.String,
    value: LocalWorkspaceSourceStateSchema,
  }),
  policies: Schema.Record({
    key: Schema.String,
    value: LocalWorkspacePolicyStateSchema,
  }),
});

export type LocalWorkspaceSourceState = typeof LocalWorkspaceSourceStateSchema.Type;
export type LocalWorkspacePolicyState = typeof LocalWorkspacePolicyStateSchema.Type;
export type LocalWorkspaceState = typeof LocalWorkspaceStateSchema.Type;

const decodeLocalWorkspaceState = Schema.decodeUnknownSync(LocalWorkspaceStateSchema);

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

const defaultLocalWorkspaceState = (): LocalWorkspaceState => ({
  version: 1,
  sources: {},
  policies: {},
});

export const localWorkspaceStatePath = (
  context: ResolvedLocalWorkspaceContext,
): string => join(context.stateDirectory, WORKSPACE_STATE_BASENAME);

export const loadLocalWorkspaceState = (
  context: ResolvedLocalWorkspaceContext,
): Effect.Effect<LocalWorkspaceState, LocalFileSystemError | LocalWorkspaceStateDecodeError> =>
  provideNodeFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = localWorkspaceStatePath(context);
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(mapFileSystemError(path, "check workspace state path")),
    );
    if (!exists) {
      return defaultLocalWorkspaceState();
    }

    const content = yield* fs.readFileString(path, "utf8").pipe(
      Effect.mapError(mapFileSystemError(path, "read workspace state")),
    );
    return yield* Effect.try({
      try: () => decodeLocalWorkspaceState(JSON.parse(content) as unknown),
      catch: (cause) => {
        return new LocalWorkspaceStateDecodeError({
          message: `Invalid local workspace state at ${path}: ${unknownLocalErrorDetails(cause)}`,
          path,
          details: unknownLocalErrorDetails(cause),
        });
      },
    });
  }));

export const writeLocalWorkspaceState = (input: {
  context: ResolvedLocalWorkspaceContext;
  state: LocalWorkspaceState;
}): Effect.Effect<void, LocalFileSystemError> =>
  provideNodeFileSystem(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(input.context.stateDirectory, { recursive: true }).pipe(
      Effect.mapError(mapFileSystemError(input.context.stateDirectory, "create state directory")),
    );
    yield* fs.writeFileString(
      localWorkspaceStatePath(input.context),
      `${JSON.stringify(input.state, null, 2)}\n`,
    ).pipe(
      Effect.mapError(mapFileSystemError(localWorkspaceStatePath(input.context), "write workspace state")),
    );
  }));
