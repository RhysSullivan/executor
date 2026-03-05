import { Atom } from "@effect-atom/atom";
import type {
  ListStorageDirectoryPayload,
  ListStorageDirectoryResult,
  ListStorageKvPayload,
  ListStorageKvResult,
  OpenStorageInstancePayload,
  QueryStorageSqlPayload,
  QueryStorageSqlResult,
  ReadStorageFilePayload,
  ReadStorageFileResult,
  RemoveStorageInstanceResult,
} from "@executor-v2/management-api/storage/api";
import type {
  StorageDurability,
  StorageInstance,
  StorageScopeType,
  WorkspaceId,
} from "@executor-v2/schema";

import { controlPlaneClient } from "../client";
import { workspaceEntity, type EntityState } from "./entity";
import { storageKeys, storageMutationKeys } from "./keys";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const storageResultByWorkspace = Atom.family(
  (workspaceId: WorkspaceId) =>
    controlPlaneClient.query("storage", "list", {
      path: { workspaceId },
      reactivityKeys: storageKeys(workspaceId),
    }),
);

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const sortStorage = (a: StorageInstance, b: StorageInstance): number => {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id.localeCompare(b.id);
};

export const storageByWorkspace = workspaceEntity(
  storageResultByWorkspace,
  sortStorage,
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const openStorageInstance = controlPlaneClient.mutation("storage", "open");
export const closeStorageInstance = controlPlaneClient.mutation("storage", "close");
export const removeStorageInstance = controlPlaneClient.mutation("storage", "remove");
export const listStorageDirectory = controlPlaneClient.mutation("storage", "listDirectory");
export const readStorageFile = controlPlaneClient.mutation("storage", "readFile");
export const listStorageKv = controlPlaneClient.mutation("storage", "listKv");
export const queryStorageSql = controlPlaneClient.mutation("storage", "querySql");

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

export const toOpenStoragePayload = (input: {
  scopeType: StorageScopeType;
  durability: StorageDurability;
  provider?: StorageInstance["provider"];
  purpose?: string;
  ttlHours?: number;
  accountId?: Exclude<StorageInstance["accountId"], null>;
  sessionId?: string;
}): OpenStorageInstancePayload => ({
  scopeType: input.scopeType,
  durability: input.durability,
  ...(input.provider !== undefined ? { provider: input.provider } : {}),
  ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
  ...(input.ttlHours !== undefined ? { ttlHours: input.ttlHours } : {}),
  ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
  ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
});

export const toOpenStorageRequest = (input: {
  workspaceId: WorkspaceId;
  payload: OpenStorageInstancePayload;
}) => ({
  path: { workspaceId: input.workspaceId },
  payload: input.payload,
  reactivityKeys: storageMutationKeys(input.workspaceId),
});

export const toCloseStorageRequest = (input: {
  workspaceId: WorkspaceId;
  storageInstanceId: StorageInstance["id"];
}) => ({
  path: {
    workspaceId: input.workspaceId,
    storageInstanceId: input.storageInstanceId,
  },
  reactivityKeys: storageMutationKeys(input.workspaceId),
});

export const toRemoveStorageRequest = (input: {
  workspaceId: WorkspaceId;
  storageInstanceId: StorageInstance["id"];
}) => ({
  path: {
    workspaceId: input.workspaceId,
    storageInstanceId: input.storageInstanceId,
  },
  reactivityKeys: storageMutationKeys(input.workspaceId),
});

export const toStorageRemoveResult = (result: RemoveStorageInstanceResult): boolean =>
  result.removed;

export const toListStorageDirectoryPayload = (input: {
  path: string;
}): ListStorageDirectoryPayload => ({ path: input.path });

export const toReadStorageFilePayload = (input: {
  path: string;
  encoding?: "utf8" | "base64";
}): ReadStorageFilePayload => ({
  path: input.path,
  ...(input.encoding !== undefined ? { encoding: input.encoding } : {}),
});

export const toListStorageKvPayload = (input: {
  prefix?: string;
  limit?: number;
}): ListStorageKvPayload => ({
  ...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
  ...(input.limit !== undefined ? { limit: input.limit } : {}),
});

export const toQueryStorageSqlPayload = (input: {
  sql: string;
  maxRows?: number;
}): QueryStorageSqlPayload => ({
  sql: input.sql,
  ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
});

// Identity passthrough functions removed — use the result types directly.
export type {
  ListStorageDirectoryResult,
  ReadStorageFileResult,
  ListStorageKvResult,
  QueryStorageSqlResult,
};

export type StorageInstancesState = EntityState<StorageInstance>;
