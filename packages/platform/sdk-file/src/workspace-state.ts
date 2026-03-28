import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import {
  defaultLocalScopeState,
  LocalScopeStateSchema,
  type LocalScopeState,
} from "@executor/platform-sdk/runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ResolvedLocalWorkspaceContext } from "./config";
import {
  LocalFileSystemError,
  LocalWorkspaceStateDecodeError,
  unknownLocalErrorDetails,
} from "./errors";

const WORKSPACE_STATE_BASENAME = "workspace-state.json";

const decodeLocalWorkspaceState = Schema.decodeUnknownSync(LocalScopeStateSchema);

const mapFileSystemError = (path: string, action: string) => (cause: unknown) =>
  new LocalFileSystemError({
    message: `Failed to ${action} ${path}: ${unknownLocalErrorDetails(cause)}`,
    action,
    path,
    details: unknownLocalErrorDetails(cause),
  });

export const localWorkspaceStatePath = (
  context: ResolvedLocalWorkspaceContext,
): string => join(context.stateDirectory, WORKSPACE_STATE_BASENAME);

export const loadLocalWorkspaceState = (
  context: ResolvedLocalWorkspaceContext,
): Effect.Effect<
  LocalScopeState,
  LocalFileSystemError | LocalWorkspaceStateDecodeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = localWorkspaceStatePath(context);
    const exists = yield* fs.exists(path).pipe(
      Effect.mapError(mapFileSystemError(path, "check workspace state path")),
    );
    if (!exists) {
      return defaultLocalScopeState();
    }

    const content = yield* fs.readFileString(path, "utf8").pipe(
      Effect.mapError(mapFileSystemError(path, "read workspace state")),
    );
    return yield* Effect.try({
      try: () => decodeLocalWorkspaceState(JSON.parse(content) as unknown),
      catch: (cause) =>
        new LocalWorkspaceStateDecodeError({
          message: `Invalid local scope state at ${path}: ${unknownLocalErrorDetails(cause)}`,
          path,
          details: unknownLocalErrorDetails(cause),
        }),
    });
  });

export const writeLocalWorkspaceState = (input: {
  context: ResolvedLocalWorkspaceContext;
  state: LocalScopeState;
}): Effect.Effect<void, LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(input.context.stateDirectory, { recursive: true }).pipe(
      Effect.mapError(
        mapFileSystemError(input.context.stateDirectory, "create state directory"),
      ),
    );
    const path = localWorkspaceStatePath(input.context);
    yield* fs.writeFileString(path, `${JSON.stringify(input.state, null, 2)}\n`).pipe(
      Effect.mapError(mapFileSystemError(path, "write workspace state")),
    );
  });
