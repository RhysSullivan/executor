import { type SourceStoreError } from "@executor-v2/persistence-ports";
import {
  type StorageInstance,
  type StorageInstanceId,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";

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
} from "./api";

export type OpenStorageInstanceInput = {
  workspaceId: WorkspaceId;
  payload: OpenStorageInstancePayload;
};

export type CloseStorageInstanceInput = {
  workspaceId: WorkspaceId;
  storageInstanceId: StorageInstanceId;
};

export type RemoveStorageInstanceInput = {
  workspaceId: WorkspaceId;
  storageInstanceId: StorageInstanceId;
};

export type ListStorageDirectoryInput = {
  workspaceId: WorkspaceId;
  storageInstanceId: StorageInstanceId;
  payload: ListStorageDirectoryPayload;
};

export type ReadStorageFileInput = {
  workspaceId: WorkspaceId;
  storageInstanceId: StorageInstanceId;
  payload: ReadStorageFilePayload;
};

export type ListStorageKvInput = {
  workspaceId: WorkspaceId;
  storageInstanceId: StorageInstanceId;
  payload: ListStorageKvPayload;
};

export type QueryStorageSqlInput = {
  workspaceId: WorkspaceId;
  storageInstanceId: StorageInstanceId;
  payload: QueryStorageSqlPayload;
};

export type ControlPlaneStorageServiceShape = {
  listStorageInstances: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<StorageInstance>, SourceStoreError>;
  openStorageInstance: (
    input: OpenStorageInstanceInput,
  ) => Effect.Effect<StorageInstance, SourceStoreError>;
  closeStorageInstance: (
    input: CloseStorageInstanceInput,
  ) => Effect.Effect<StorageInstance, SourceStoreError>;
  removeStorageInstance: (
    input: RemoveStorageInstanceInput,
  ) => Effect.Effect<RemoveStorageInstanceResult, SourceStoreError>;
  listStorageDirectory: (
    input: ListStorageDirectoryInput,
  ) => Effect.Effect<ListStorageDirectoryResult, SourceStoreError>;
  readStorageFile: (
    input: ReadStorageFileInput,
  ) => Effect.Effect<ReadStorageFileResult, SourceStoreError>;
  listStorageKv: (
    input: ListStorageKvInput,
  ) => Effect.Effect<ListStorageKvResult, SourceStoreError>;
  queryStorageSql: (
    input: QueryStorageSqlInput,
  ) => Effect.Effect<QueryStorageSqlResult, SourceStoreError>;
};

export const makeControlPlaneStorageService = (
  service: ControlPlaneStorageServiceShape,
): ControlPlaneStorageServiceShape => service;
