import type { Source, SourceId, WorkspaceId } from "@executor-v2/schema";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

export class SourceStoreError extends Data.TaggedError("SourceStoreError")<{
  operation: string;
  filePath: string;
  message: string;
  reason: string | null;
  details: string | null;
}> {}

export interface SourceStore {
  getById(
    workspaceId: WorkspaceId,
    sourceId: SourceId,
  ): Effect.Effect<Option.Option<Source>, SourceStoreError>;

  listByWorkspace(workspaceId: WorkspaceId): Effect.Effect<ReadonlyArray<Source>, SourceStoreError>;

  upsert(source: Source): Effect.Effect<void, SourceStoreError>;

  removeById(
    workspaceId: WorkspaceId,
    sourceId: SourceId,
  ): Effect.Effect<boolean, SourceStoreError>;
}

export class SourceStoreService extends Context.Tag(
  "@executor-v2/persistence-ports/SourceStoreService",
)<SourceStoreService, SourceStore>() {}
