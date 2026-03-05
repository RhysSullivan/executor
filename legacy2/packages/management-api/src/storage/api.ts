import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import {
  AccountIdSchema,
  StorageDurabilitySchema,
  StorageInstanceIdSchema,
  StorageInstanceSchema,
  StorageProviderSchema,
  StorageScopeTypeSchema,
  WorkspaceIdSchema,
} from "@executor-v2/schema";
import * as Schema from "effect/Schema";

import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  ControlPlaneUnauthorizedError,
} from "../errors";

const RequiredOpenStorageInstancePayloadSchema = Schema.Struct({
  scopeType: StorageScopeTypeSchema,
  durability: StorageDurabilitySchema,
});

const OptionalOpenStorageInstancePayloadSchema = Schema.Struct({
  provider: StorageProviderSchema,
  purpose: Schema.String,
  ttlHours: Schema.Number,
  accountId: AccountIdSchema,
  sessionId: Schema.String,
}).pipe(Schema.partialWith({ exact: true }));

export const OpenStorageInstancePayloadSchema =
  RequiredOpenStorageInstancePayloadSchema.pipe(
    Schema.extend(OptionalOpenStorageInstancePayloadSchema),
  );

export type OpenStorageInstancePayload =
  typeof OpenStorageInstancePayloadSchema.Type;

export const RemoveStorageInstanceResultSchema = Schema.Struct({
  removed: Schema.Boolean,
});

export type RemoveStorageInstanceResult =
  typeof RemoveStorageInstanceResultSchema.Type;

export const ListStorageDirectoryPayloadSchema = Schema.Struct({
  path: Schema.String,
});

export type ListStorageDirectoryPayload =
  typeof ListStorageDirectoryPayloadSchema.Type;

export const StorageDirectoryEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literal("file", "directory"),
  sizeBytes: Schema.NullOr(Schema.Number),
  updatedAt: Schema.Number,
});

export type StorageDirectoryEntry = typeof StorageDirectoryEntrySchema.Type;

export const ListStorageDirectoryResultSchema = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(StorageDirectoryEntrySchema),
});

export type ListStorageDirectoryResult =
  typeof ListStorageDirectoryResultSchema.Type;

const RequiredReadStorageFilePayloadSchema = Schema.Struct({
  path: Schema.String,
});

const OptionalReadStorageFilePayloadSchema = Schema.Struct({
  encoding: Schema.Literal("utf8", "base64"),
}).pipe(Schema.partialWith({ exact: true }));

export const ReadStorageFilePayloadSchema =
  RequiredReadStorageFilePayloadSchema.pipe(
    Schema.extend(OptionalReadStorageFilePayloadSchema),
  );

export type ReadStorageFilePayload = typeof ReadStorageFilePayloadSchema.Type;

export const ReadStorageFileResultSchema = Schema.Struct({
  path: Schema.String,
  encoding: Schema.Literal("utf8", "base64"),
  content: Schema.String,
  bytes: Schema.Number,
});

export type ReadStorageFileResult = typeof ReadStorageFileResultSchema.Type;

export const ListStorageKvPayloadSchema = Schema.Struct({
  prefix: Schema.String,
  limit: Schema.Number,
}).pipe(Schema.partialWith({ exact: true }));

export type ListStorageKvPayload = typeof ListStorageKvPayloadSchema.Type;

export const StorageKvItemSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.Unknown,
});

export type StorageKvItem = typeof StorageKvItemSchema.Type;

export const ListStorageKvResultSchema = Schema.Struct({
  items: Schema.Array(StorageKvItemSchema),
});

export type ListStorageKvResult = typeof ListStorageKvResultSchema.Type;

const RequiredQueryStorageSqlPayloadSchema = Schema.Struct({
  sql: Schema.String,
});

const OptionalQueryStorageSqlPayloadSchema = Schema.Struct({
  maxRows: Schema.Number,
}).pipe(Schema.partialWith({ exact: true }));

export const QueryStorageSqlPayloadSchema =
  RequiredQueryStorageSqlPayloadSchema.pipe(
    Schema.extend(OptionalQueryStorageSqlPayloadSchema),
  );

export type QueryStorageSqlPayload = typeof QueryStorageSqlPayloadSchema.Type;

const SqlRowSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

export type SqlRow = typeof SqlRowSchema.Type;

export const QueryStorageSqlResultSchema = Schema.Struct({
  rows: Schema.Array(SqlRowSchema),
  columns: Schema.Array(Schema.String),
  rowCount: Schema.Number,
});

export type QueryStorageSqlResult = typeof QueryStorageSqlResultSchema.Type;

const workspaceIdParam = HttpApiSchema.param("workspaceId", WorkspaceIdSchema);
const storageInstanceIdParam = HttpApiSchema.param(
  "storageInstanceId",
  StorageInstanceIdSchema,
);

export class StorageApi extends HttpApiGroup.make("storage")
  .add(
    HttpApiEndpoint.get("list")`/workspaces/${workspaceIdParam}/storage-instances`
      .addSuccess(Schema.Array(StorageInstanceSchema))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("open")`/workspaces/${workspaceIdParam}/storage-instances/open`
      .setPayload(OpenStorageInstancePayloadSchema)
      .addSuccess(StorageInstanceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post(
      "close",
    )`/workspaces/${workspaceIdParam}/storage-instances/${storageInstanceIdParam}/close`
      .addSuccess(StorageInstanceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del(
      "remove",
    )`/workspaces/${workspaceIdParam}/storage-instances/${storageInstanceIdParam}`
      .addSuccess(RemoveStorageInstanceResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post(
      "listDirectory",
    )`/workspaces/${workspaceIdParam}/storage-instances/${storageInstanceIdParam}/fs/list`
      .setPayload(ListStorageDirectoryPayloadSchema)
      .addSuccess(ListStorageDirectoryResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post(
      "readFile",
    )`/workspaces/${workspaceIdParam}/storage-instances/${storageInstanceIdParam}/fs/read`
      .setPayload(ReadStorageFilePayloadSchema)
      .addSuccess(ReadStorageFileResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post(
      "listKv",
    )`/workspaces/${workspaceIdParam}/storage-instances/${storageInstanceIdParam}/kv/list`
      .setPayload(ListStorageKvPayloadSchema)
      .addSuccess(ListStorageKvResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post(
      "querySql",
    )`/workspaces/${workspaceIdParam}/storage-instances/${storageInstanceIdParam}/sql/query`
      .setPayload(QueryStorageSqlPayloadSchema)
      .addSuccess(QueryStorageSqlResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneUnauthorizedError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1") {}
