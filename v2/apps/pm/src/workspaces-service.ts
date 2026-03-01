import { SourceStoreError } from "@executor-v2/persistence-ports";
import {
  makeControlPlaneWorkspacesService,
  type ControlPlaneWorkspacesServiceShape,
} from "@executor-v2/management-api";
import {
  type LocalStateSnapshot,
  type LocalStateStore,
  type LocalStateStoreError,
} from "@executor-v2/persistence-local";
import { type Workspace } from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const toSourceStoreError = (
  operation: string,
  message: string,
  details: string | null,
): SourceStoreError =>
  new SourceStoreError({
    operation,
    backend: "local-file",
    location: "snapshot.json",
    message,
    reason: null,
    details,
  });

const toSourceStoreErrorFromLocalState = (
  operation: string,
  error: LocalStateStoreError,
): SourceStoreError =>
  toSourceStoreError(operation, error.message, error.details ?? error.reason ?? null);

const sortWorkspaces = (workspaces: ReadonlyArray<Workspace>): Array<Workspace> =>
  [...workspaces].sort((left, right) => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName === rightName) {
      return left.id.localeCompare(right.id);
    }

    return leftName.localeCompare(rightName);
  });

const replaceWorkspaceAt = (
  snapshot: LocalStateSnapshot,
  index: number,
  workspace: Workspace,
): LocalStateSnapshot => {
  const next = [...snapshot.workspaces];
  next[index] = workspace;

  return {
    ...snapshot,
    generatedAt: Date.now(),
    workspaces: next,
  };
};

const appendWorkspace = (
  snapshot: LocalStateSnapshot,
  workspace: Workspace,
): LocalStateSnapshot => ({
  ...snapshot,
  generatedAt: Date.now(),
  workspaces: [...snapshot.workspaces, workspace],
});

export const createPmWorkspacesService = (
  localStateStore: LocalStateStore,
): ControlPlaneWorkspacesServiceShape =>
  makeControlPlaneWorkspacesService({
    listWorkspaces: () =>
      Effect.gen(function* () {
        const snapshotOption = yield* localStateStore.getSnapshot().pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("workspaces.list", error),
          ),
        );

        const snapshot = Option.getOrNull(snapshotOption);
        if (snapshot === null) {
          return [];
        }

        return sortWorkspaces(snapshot.workspaces);
      }),

    upsertWorkspace: (input) =>
      Effect.gen(function* () {
        const snapshotOption = yield* localStateStore.getSnapshot().pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("workspaces.upsert", error),
          ),
        );

        const snapshot = Option.getOrNull(snapshotOption);
        if (snapshot === null) {
          return yield* toSourceStoreError(
            "workspaces.upsert",
            "Workspace snapshot not found",
            null,
          );
        }

        const now = Date.now();
        const existingIndex = input.payload.id
          ? snapshot.workspaces.findIndex((workspace) => workspace.id === input.payload.id)
          : -1;
        const existing = existingIndex >= 0 ? snapshot.workspaces[existingIndex] : null;

        const nextWorkspace: Workspace = {
          id: existing?.id ?? (input.payload.id ?? (`ws_${crypto.randomUUID()}` as Workspace["id"])),
          organizationId: input.payload.organizationId,
          name: input.payload.name,
          createdByAccountId: existing?.createdByAccountId ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        const nextSnapshot = existingIndex >= 0
          ? replaceWorkspaceAt(snapshot, existingIndex, nextWorkspace)
          : appendWorkspace(snapshot, nextWorkspace);

        yield* localStateStore.writeSnapshot(nextSnapshot).pipe(
          Effect.mapError((error) =>
            toSourceStoreErrorFromLocalState("workspaces.upsert_write", error),
          ),
        );

        return nextWorkspace;
      }),
  });
