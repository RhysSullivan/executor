import {
  makeControlPlaneStorageService,
  type ControlPlaneStorageServiceShape,
} from "@executor-v2/management-api";
import { type SourceStoreError } from "@executor-v2/persistence-ports";
import { type SqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import {
  type OrganizationId,
  type StorageInstance,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { createSqlSourceStoreErrorMapper } from "./control-plane-row-helpers";
import {
  DEFAULT_EPHEMERAL_TTL_HOURS,
  initializeStorageInstanceFiles,
  listStorageDirectoryFromFilesystem,
  listStorageKvFromFilesystem,
  queryStorageSqliteFile,
  readStorageFileFromFilesystem,
  removeStorageInstanceFiles,
} from "./storage-local-backend";

const sourceStoreError = createSqlSourceStoreErrorMapper("storage");

type StorageRows = Pick<
  SqlControlPlanePersistence["rows"],
  "workspaces" | "storageInstances"
>;

const MILLIS_PER_HOUR = 3_600_000;

const canAccessStorageInstance = (
  instance: StorageInstance,
  workspaceId: WorkspaceId,
  organizationId: OrganizationId,
): boolean =>
  instance.workspaceId === workspaceId
  || (instance.workspaceId === null && instance.organizationId === organizationId);

const sortStorageInstances = (
  storageInstances: ReadonlyArray<StorageInstance>,
): Array<StorageInstance> =>
  [...storageInstances].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }

    return left.id.localeCompare(right.id);
  });

const findStorageInstance = (
  storageInstances: ReadonlyArray<StorageInstance>,
  organizationId: OrganizationId,
  input: {
    workspaceId: WorkspaceId;
    storageInstanceId: StorageInstance["id"];
  },
): {
  storageInstance: StorageInstance;
} | null => {
  const storageInstance = storageInstances.find((instance) =>
    instance.id === input.storageInstanceId
    && canAccessStorageInstance(instance, input.workspaceId, organizationId)
  );

  if (!storageInstance) {
    return null;
  }

  return {
    storageInstance,
  };
};

const touchStorageInstance = (
  rows: StorageRows,
  existing: StorageInstance,
  operation: string,
): Effect.Effect<StorageInstance, SourceStoreError> => {
  const now = Date.now();
  const next: StorageInstance = {
    ...existing,
    updatedAt: now,
    lastSeenAt: now,
  };

  return rows.storageInstances.upsert(next).pipe(
    Effect.mapError((error) => sourceStoreError.fromRowStore(operation, error)),
    Effect.as(next),
  );
};

const loadStorageScope = (
  rows: StorageRows,
  input: {
    workspaceId: WorkspaceId;
    instancesOperation: string;
    workspaceOperation: string;
  },
): Effect.Effect<
  {
    storageInstances: ReadonlyArray<StorageInstance>;
    organizationId: OrganizationId;
  },
  SourceStoreError
> =>
  rows.workspaces.getById(input.workspaceId).pipe(
    Effect.mapError((error) =>
      sourceStoreError.fromRowStore(input.workspaceOperation, error),
    ),
    Effect.flatMap((workspaceOption) => {
      const workspace = Option.getOrNull(workspaceOption);
      if (workspace === null) {
        return sourceStoreError.fromMessage(
          input.workspaceOperation,
          "Workspace not found",
          `workspace=${input.workspaceId}`,
        );
      }

      return rows.storageInstances.listByWorkspaceScope(
        input.workspaceId,
        workspace.organizationId,
      ).pipe(
        Effect.mapError((error) =>
          sourceStoreError.fromRowStore(input.instancesOperation, error),
        ),
        Effect.map((storageInstances) => ({
          storageInstances,
          organizationId: workspace.organizationId,
        })),
      );
    }),
  );

export const createRuntimeHostStorageService = (
  rows: StorageRows,
  options: {
    stateRootDir: string;
  },
): ControlPlaneStorageServiceShape =>
  makeControlPlaneStorageService({
    listStorageInstances: (workspaceId) =>
      Effect.gen(function* () {
        const { storageInstances, organizationId } = yield* loadStorageScope(rows, {
          workspaceId,
          instancesOperation: "storage.list_instances",
          workspaceOperation: "storage.list_instances.workspace",
        });

        return sortStorageInstances(storageInstances);
      }),

    openStorageInstance: (input) =>
      Effect.gen(function* () {
        if (input.payload.scopeType === "account" && input.payload.accountId === undefined) {
          return yield* sourceStoreError.fromMessage(
            "storage.open",
            "Account scope storage requires accountId",
            `workspace=${input.workspaceId}`,
          );
        }

        const workspaceOption = yield* rows.workspaces.getById(input.workspaceId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("storage.open.workspace", error),
          ),
        );

        const workspace = Option.getOrNull(workspaceOption);
        if (workspace === null) {
          return yield* sourceStoreError.fromMessage(
            "storage.open",
            "Workspace not found",
            `workspace=${input.workspaceId}`,
          );
        }

        const now = Date.now();
        const organizationId = workspace.organizationId;
        const storageInstanceId =
          `storage_${crypto.randomUUID()}` as StorageInstance["id"];
        const ttlHours =
          input.payload.ttlHours !== undefined && Number.isFinite(input.payload.ttlHours)
            ? Math.max(1, Math.floor(input.payload.ttlHours))
            : DEFAULT_EPHEMERAL_TTL_HOURS;

        yield* Effect.tryPromise({
          try: () => initializeStorageInstanceFiles(options.stateRootDir, storageInstanceId),
          catch: (cause) =>
            sourceStoreError.fromCause(
              "storage.open_initialize",
              cause,
              `storageInstance=${storageInstanceId}`,
            ),
        });

        const nextStorageInstance: StorageInstance = {
          id: storageInstanceId,
          scopeType: input.payload.scopeType,
          durability: input.payload.durability,
          status: "active",
          provider: input.payload.provider ?? "agentfs-local",
          backendKey: `local:${storageInstanceId}`,
          organizationId,
          workspaceId:
            input.payload.scopeType === "workspace" || input.payload.scopeType === "scratch"
              ? input.workspaceId
              : null,
          accountId:
            input.payload.scopeType === "account"
              ? (input.payload.accountId ?? null)
              : null,
          createdByAccountId: input.payload.accountId ?? null,
          purpose:
            input.payload.purpose !== undefined && input.payload.purpose.trim().length > 0
              ? input.payload.purpose.trim()
              : null,
          sizeBytes: null,
          fileCount: null,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          closedAt: null,
          expiresAt:
            input.payload.durability === "ephemeral"
              ? now + ttlHours * MILLIS_PER_HOUR
              : null,
        };

        yield* rows.storageInstances.upsert(nextStorageInstance).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("storage.open_write", error),
          ),
        );

        return nextStorageInstance;
      }),

    closeStorageInstance: (input) =>
      Effect.gen(function* () {
        const { storageInstances, organizationId } = yield* loadStorageScope(rows, {
          workspaceId: input.workspaceId,
          instancesOperation: "storage.close.instances",
          workspaceOperation: "storage.close.workspace",
        });

        const found = findStorageInstance(storageInstances, organizationId, {
          workspaceId: input.workspaceId,
          storageInstanceId: input.storageInstanceId,
        });

        if (found === null) {
          return yield* sourceStoreError.fromMessage(
            "storage.close",
            "Storage instance not found",
            `workspace=${input.workspaceId} id=${input.storageInstanceId}`,
          );
        }

        const now = Date.now();
        const nextStorageInstance: StorageInstance = {
          ...found.storageInstance,
          status: "closed",
          updatedAt: now,
          lastSeenAt: now,
          closedAt: found.storageInstance.closedAt ?? now,
        };

        yield* rows.storageInstances.upsert(nextStorageInstance).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("storage.close_write", error),
          ),
        );

        return nextStorageInstance;
      }),

    removeStorageInstance: (input) =>
      Effect.gen(function* () {
        const { storageInstances, organizationId } = yield* loadStorageScope(rows, {
          workspaceId: input.workspaceId,
          instancesOperation: "storage.remove.instances",
          workspaceOperation: "storage.remove.workspace",
        });

        const found = findStorageInstance(storageInstances, organizationId, {
          workspaceId: input.workspaceId,
          storageInstanceId: input.storageInstanceId,
        });

        if (found === null) {
          return {
            removed: false,
          };
        }

        yield* Effect.tryPromise({
          try: () =>
            removeStorageInstanceFiles(options.stateRootDir, input.storageInstanceId),
          catch: (cause) =>
            sourceStoreError.fromCause(
              "storage.remove_files",
              cause,
              `storageInstance=${input.storageInstanceId}`,
            ),
        });

        const removed = yield* rows.storageInstances.removeById(input.storageInstanceId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("storage.remove_write", error),
          ),
        );

        return {
          removed,
        };
      }),

    listStorageDirectory: (input) =>
      Effect.gen(function* () {
        const { storageInstances, organizationId } = yield* loadStorageScope(rows, {
          workspaceId: input.workspaceId,
          instancesOperation: "storage.list_directory.instances",
          workspaceOperation: "storage.list_directory.workspace",
        });

        const found = findStorageInstance(storageInstances, organizationId, {
          workspaceId: input.workspaceId,
          storageInstanceId: input.storageInstanceId,
        });

        if (found === null) {
          return yield* sourceStoreError.fromMessage(
            "storage.listDirectory",
            "Storage instance not found",
            `workspace=${input.workspaceId} id=${input.storageInstanceId}`,
          );
        }

        const result = yield* Effect.tryPromise({
          try: () =>
            listStorageDirectoryFromFilesystem(
              options.stateRootDir,
              found.storageInstance.id,
              input.payload,
            ),
          catch: (cause) =>
            sourceStoreError.fromCause(
              "storage.listDirectory_read",
              cause,
              `storageInstance=${found.storageInstance.id} path=${input.payload.path}`,
            ),
        });

        yield* touchStorageInstance(
          rows,
          found.storageInstance,
          "storage.listDirectory_touch",
        );

        return result;
      }),

    readStorageFile: (input) =>
      Effect.gen(function* () {
        const { storageInstances, organizationId } = yield* loadStorageScope(rows, {
          workspaceId: input.workspaceId,
          instancesOperation: "storage.read_file.instances",
          workspaceOperation: "storage.read_file.workspace",
        });

        const found = findStorageInstance(storageInstances, organizationId, {
          workspaceId: input.workspaceId,
          storageInstanceId: input.storageInstanceId,
        });

        if (found === null) {
          return yield* sourceStoreError.fromMessage(
            "storage.readFile",
            "Storage instance not found",
            `workspace=${input.workspaceId} id=${input.storageInstanceId}`,
          );
        }

        const result = yield* Effect.tryPromise({
          try: () =>
            readStorageFileFromFilesystem(
              options.stateRootDir,
              found.storageInstance.id,
              input.payload,
            ),
          catch: (cause) =>
            sourceStoreError.fromCause(
              "storage.readFile_read",
              cause,
              `storageInstance=${found.storageInstance.id} path=${input.payload.path}`,
            ),
        });

        yield* touchStorageInstance(rows, found.storageInstance, "storage.readFile_touch");

        return result;
      }),

    listStorageKv: (input) =>
      Effect.gen(function* () {
        const { storageInstances, organizationId } = yield* loadStorageScope(rows, {
          workspaceId: input.workspaceId,
          instancesOperation: "storage.list_kv.instances",
          workspaceOperation: "storage.list_kv.workspace",
        });

        const found = findStorageInstance(storageInstances, organizationId, {
          workspaceId: input.workspaceId,
          storageInstanceId: input.storageInstanceId,
        });

        if (found === null) {
          return yield* sourceStoreError.fromMessage(
            "storage.listKv",
            "Storage instance not found",
            `workspace=${input.workspaceId} id=${input.storageInstanceId}`,
          );
        }

        const result = yield* Effect.tryPromise({
          try: () =>
            listStorageKvFromFilesystem(
              options.stateRootDir,
              found.storageInstance.id,
              input.payload,
            ),
          catch: (cause) =>
            sourceStoreError.fromCause(
              "storage.listKv_read",
              cause,
              `storageInstance=${found.storageInstance.id}`,
            ),
        });

        yield* touchStorageInstance(rows, found.storageInstance, "storage.listKv_touch");

        return result;
      }),

    queryStorageSql: (input) =>
      Effect.gen(function* () {
        const { storageInstances, organizationId } = yield* loadStorageScope(rows, {
          workspaceId: input.workspaceId,
          instancesOperation: "storage.query_sql.instances",
          workspaceOperation: "storage.query_sql.workspace",
        });

        const found = findStorageInstance(storageInstances, organizationId, {
          workspaceId: input.workspaceId,
          storageInstanceId: input.storageInstanceId,
        });

        if (found === null) {
          return yield* sourceStoreError.fromMessage(
            "storage.querySql",
            "Storage instance not found",
            `workspace=${input.workspaceId} id=${input.storageInstanceId}`,
          );
        }

        const sqlText = input.payload.sql.trim();
        if (sqlText.length === 0) {
          return yield* sourceStoreError.fromMessage(
            "storage.querySql",
            "SQL query is required",
            `workspace=${input.workspaceId} id=${input.storageInstanceId}`,
          );
        }

        const result = yield* Effect.tryPromise({
          try: () =>
            queryStorageSqliteFile(options.stateRootDir, found.storageInstance.id, {
              ...input.payload,
              sql: sqlText,
            }),
          catch: (cause) =>
            sourceStoreError.fromCause(
              "storage.querySql_run",
              cause,
              `storageInstance=${found.storageInstance.id}`,
            ),
        });

        yield* touchStorageInstance(rows, found.storageInstance, "storage.querySql_touch");

        return result;
      }),
  });
