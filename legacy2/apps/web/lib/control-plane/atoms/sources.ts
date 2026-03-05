import { Atom, Result } from "@effect-atom/atom";
import type { Source, SourceId, WorkspaceId } from "@executor-v2/schema";
import type { UpsertSourcePayload } from "@executor-v2/management-api/sources/api";
import * as Option from "effect/Option";

import { controlPlaneClient } from "../client";
import { stateFromResult, type EntityState } from "./entity";
import { sourceMutationKeys, sourcesKeys } from "./keys";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const sourcesResultByWorkspace = Atom.family(
  (workspaceId: WorkspaceId) =>
    controlPlaneClient.query("sources", "list", {
      path: { workspaceId },
      reactivityKeys: sourcesKeys(workspaceId),
    }),
);

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const sortSources = (a: Source, b: Source): number => {
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  if (aName === bName) return `${a.workspaceId}:${a.id}`.localeCompare(`${b.workspaceId}:${b.id}`);
  return aName.localeCompare(bName);
};

// ---------------------------------------------------------------------------
// Optimistic update support (sources-only pattern)
// ---------------------------------------------------------------------------

type OptimisticPendingAck =
  | { kind: "upsert"; sourceId: SourceId }
  | { kind: "remove"; sourceId: SourceId };

type OptimisticSources = {
  items: ReadonlyArray<Source>;
  pendingAck: OptimisticPendingAck;
};

export const optimisticSourcesByWorkspace = Atom.family((workspaceId: WorkspaceId) =>
  Atom.make<OptimisticSources | null>(null),
);

const isAcknowledged = (
  serverSources: ReadonlyArray<Source>,
  pendingAck: OptimisticPendingAck,
): boolean => {
  const hasSource = serverSources.some((s) => s.id === pendingAck.sourceId);
  return pendingAck.kind === "upsert" ? hasSource : !hasSource;
};

export const sourcesPendingByWorkspace = Atom.family((workspaceId: WorkspaceId) =>
  Atom.make((get): boolean => {
    const optimistic = get(optimisticSourcesByWorkspace(workspaceId));
    if (optimistic === null) return false;

    const serverResult = get(sourcesResultByWorkspace(workspaceId));
    return Result.match(serverResult, {
      onInitial: () => true,
      onFailure: () => true,
      onSuccess: (success) => !isAcknowledged(success.value, optimistic.pendingAck),
    });
  }),
);

const sortSourceArray = (items: ReadonlyArray<Source>) => [...items].sort(sortSources);

export const sourcesByWorkspace = Atom.family((workspaceId: WorkspaceId) =>
  Atom.make((get): EntityState<Source> => {
    const serverResult = get(sourcesResultByWorkspace(workspaceId));
    const serverState = stateFromResult(serverResult, sortSourceArray);
    const optimistic = get(optimisticSourcesByWorkspace(workspaceId));

    if (optimistic === null) return serverState;

    return Result.match(serverResult, {
      onInitial: () => ({ state: "ready" as const, items: optimistic.items, message: null }),
      onFailure: () => ({ state: "ready" as const, items: optimistic.items, message: null }),
      onSuccess: (success) =>
        isAcknowledged(success.value, optimistic.pendingAck)
          ? serverState
          : { state: "ready" as const, items: optimistic.items, message: null },
    });
  }),
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const upsertSource = controlPlaneClient.mutation("sources", "upsert");
export const removeSource = controlPlaneClient.mutation("sources", "remove");

export const toUpsertSourceRequest = (input: {
  workspaceId: WorkspaceId;
  payload: UpsertSourcePayload;
}) => ({
  path: { workspaceId: input.workspaceId },
  payload: input.payload,
  reactivityKeys: sourceMutationKeys(input.workspaceId),
});

export const toRemoveSourceRequest = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
}) => ({
  path: {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
  },
  reactivityKeys: sourceMutationKeys(input.workspaceId),
});

// ---------------------------------------------------------------------------
// Optimistic helpers
// ---------------------------------------------------------------------------

export const optimisticUpsertSources = (
  currentSources: ReadonlyArray<Source>,
  workspaceId: WorkspaceId,
  payload: UpsertSourcePayload,
): { sourceId: SourceId; items: ReadonlyArray<Source> } => {
  const sourceId = payload.id as SourceId;
  const existing = currentSources.find((s) => s.id === sourceId);
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

  const next = currentSources.filter((item) => item.id !== sourceId);
  return { sourceId, items: sortSourceArray([...next, source]) };
};

export const optimisticRemoveSources = (
  currentSources: ReadonlyArray<Source>,
  sourceId: SourceId,
): { sourceId: SourceId; items: ReadonlyArray<Source> } => ({
  sourceId,
  items: currentSources.filter((s) => s.id !== sourceId),
});

// Re-export the state type
export type { EntityState as SourcesState } from "./entity";
