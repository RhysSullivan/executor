import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AccountId, WorkspaceId } from "#schema";
import type {
  LoadedLocalExecutorConfig,
  ResolvedLocalWorkspaceContext,
} from "./local-config";
import {
  RuntimeLocalWorkspaceMismatchError,
  RuntimeLocalWorkspaceUnavailableError,
} from "./local-errors";

export type RuntimeLocalWorkspaceState = {
  context: ResolvedLocalWorkspaceContext;
  installation: {
    workspaceId: WorkspaceId;
    accountId: AccountId;
  };
  loadedConfig: LoadedLocalExecutorConfig;
};

export class RuntimeLocalWorkspaceService extends Context.Tag(
  "#runtime/RuntimeLocalWorkspaceService",
)<RuntimeLocalWorkspaceService, RuntimeLocalWorkspaceState>() {}

export const getRuntimeLocalWorkspaceOption = () =>
  Effect.contextWith((context) =>
    Context.getOption(context, RuntimeLocalWorkspaceService),
  ).pipe(
    Effect.map((option) => (Option.isSome(option) ? option.value : null)),
  ) as Effect.Effect<RuntimeLocalWorkspaceState | null, never, never>;

export const requireRuntimeLocalWorkspace = (
  workspaceId?: WorkspaceId,
): Effect.Effect<
  RuntimeLocalWorkspaceState,
  RuntimeLocalWorkspaceUnavailableError | RuntimeLocalWorkspaceMismatchError,
  never
> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* getRuntimeLocalWorkspaceOption();
    if (runtimeLocalWorkspace === null) {
      return yield* Effect.fail(
        new RuntimeLocalWorkspaceUnavailableError({
          message: "Runtime local workspace is unavailable",
        }),
      );
    }

    if (
      workspaceId !== undefined
      && runtimeLocalWorkspace.installation.workspaceId !== workspaceId
    ) {
      return yield* Effect.fail(
        new RuntimeLocalWorkspaceMismatchError({
          message: `Workspace ${workspaceId} is not the active local workspace ${runtimeLocalWorkspace.installation.workspaceId}`,
          requestedWorkspaceId: workspaceId,
          activeWorkspaceId: runtimeLocalWorkspace.installation.workspaceId,
        }),
      );
    }

    return runtimeLocalWorkspace;
  });

export const requireRuntimeLocalAccountId = (workspaceId?: WorkspaceId) =>
  requireRuntimeLocalWorkspace(workspaceId).pipe(
    Effect.map((runtimeLocalWorkspace) => runtimeLocalWorkspace.installation.accountId),
  );
