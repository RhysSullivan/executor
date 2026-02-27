import { Atom, Result } from "@effect-atom/atom";
import type { UpsertSourcePayload } from "@executor-v2/control-plane";
import type { Source, SourceId, WorkspaceId } from "@executor-v2/schema";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

import { controlPlaneClient } from "./client";

type SourcesResult = Result.Result<ReadonlyArray<Source>, unknown>;

const emptySources: ReadonlyArray<Source> = [];

const sourceStoreKey = (source: Source): string => `${source.workspaceId}:${source.id}`;

const sortSources = (sources: ReadonlyArray<Source>): Array<Source> =>
  [...sources].sort((left, right) => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName === rightName) {
      return sourceStoreKey(left).localeCompare(sourceStoreKey(right));
    }

    return leftName.localeCompare(rightName);
  });

export const sourcesResultByWorkspace = Atom.family(
  (workspaceId: WorkspaceId): Atom.Atom<SourcesResult> =>
    controlPlaneClient.query("sources", "list", {
      path: {
        workspaceId,
      },
    }) as Atom.Atom<SourcesResult>,
);

type OptimisticPendingAck =
  | {
      kind: "upsert";
      sourceId: SourceId;
    }
  | {
      kind: "remove";
      sourceId: SourceId;
    };

type OptimisticSources = {
  items: ReadonlyArray<Source>;
  pendingAck: OptimisticPendingAck;
};

export const optimisticSourcesByWorkspace = Atom.family((workspaceId: WorkspaceId) =>
  Atom.make<OptimisticSources | null>(null),
);

export const upsertSource = controlPlaneClient.mutation("sources", "upsert");
export const removeSource = controlPlaneClient.mutation("sources", "remove");

export type SourcesState =
  | {
      state: "loading";
      items: ReadonlyArray<Source>;
      message: null;
    }
  | {
      state: "error";
      items: ReadonlyArray<Source>;
      message: string;
    }
  | {
      state: "ready";
      items: ReadonlyArray<Source>;
      message: null;
    };

const sourceStateFromResult = (result: SourcesResult): SourcesState =>
  Result.match(result, {
    onInitial: () => ({
      state: "loading",
      items: emptySources,
      message: null,
    }),
    onFailure: (failure) => ({
      state: "error",
      items: Option.getOrElse(Result.value(result), () => emptySources),
      message: Cause.pretty(failure.cause),
    }),
    onSuccess: (success) => ({
      state: "ready",
      items: success.value,
      message: null,
    }),
  });

const isAcknowledged = (
  serverSources: ReadonlyArray<Source>,
  pendingAck: OptimisticPendingAck,
): boolean => {
  const hasSource = serverSources.some((source) => source.id === pendingAck.sourceId);
  return pendingAck.kind === "upsert" ? hasSource : !hasSource;
};

export const optimisticUpsertSources = (
  currentSources: ReadonlyArray<Source>,
  workspaceId: WorkspaceId,
  payload: UpsertSourcePayload,
): {
  sourceId: SourceId;
  items: ReadonlyArray<Source>;
} => {
  const sourceId = payload.id as SourceId;
  const existing = currentSources.find((source) => source.id === sourceId);
  const now = Date.now();

  const source: Source = {
    id: sourceId,
    workspaceId,
    name: payload.name,
    kind: payload.kind,
    endpoint: payload.endpoint,
    status: payload.status ?? "draft",
    enabled: payload.enabled ?? true,
    configJson: payload.configJson ?? "{}",
    sourceHash: payload.sourceHash ?? null,
    lastError: payload.lastError ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const nextSources = currentSources.filter((item) => item.id !== sourceId);
  return {
    sourceId,
    items: sortSources([...nextSources, source]),
  };
};

export const optimisticRemoveSources = (
  currentSources: ReadonlyArray<Source>,
  sourceId: SourceId,
): {
  sourceId: SourceId;
  items: ReadonlyArray<Source>;
} => ({
  sourceId,
  items: currentSources.filter((source) => source.id !== sourceId),
});

export const sourcesPendingByWorkspace = Atom.family((workspaceId: WorkspaceId) =>
  Atom.make((get): boolean => {
    const optimistic = get(optimisticSourcesByWorkspace(workspaceId));

    if (optimistic === null) {
      return false;
    }

    const serverResult = get(sourcesResultByWorkspace(workspaceId));

    return Result.match(serverResult, {
      onInitial: () => true,
      onFailure: () => true,
      onSuccess: (success) =>
        !isAcknowledged(success.value, optimistic.pendingAck),
    });
  }),
);

export const sourcesByWorkspace = Atom.family((workspaceId: WorkspaceId) =>
  Atom.make((get): SourcesState => {
    const serverResult = get(sourcesResultByWorkspace(workspaceId));
    const serverState = sourceStateFromResult(serverResult);
    const optimistic = get(optimisticSourcesByWorkspace(workspaceId));

    if (optimistic === null) {
      return serverState;
    }

    return Result.match(serverResult, {
      onInitial: () => ({
        state: "ready",
        items: optimistic.items,
        message: null,
      }),
      onFailure: () => ({
        state: "ready",
        items: optimistic.items,
        message: null,
      }),
      onSuccess: (success) =>
        isAcknowledged(success.value, optimistic.pendingAck)
          ? serverState
          : {
              state: "ready",
              items: optimistic.items,
              message: null,
            },
    });
  }),
);
