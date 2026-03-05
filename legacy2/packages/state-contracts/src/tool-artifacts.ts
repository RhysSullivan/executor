import type { SourceId, ToolArtifact, WorkspaceId } from "@executor-v2/schema";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

export class ToolArtifactStoreError extends Data.TaggedError("ToolArtifactStoreError")<{
  operation: string;
  backend: string;
  location: string;
  message: string;
  reason: string | null;
  details: string | null;
}> {}

export interface ToolArtifactStore {
  getBySource(
    workspaceId: WorkspaceId,
    sourceId: SourceId,
  ): Effect.Effect<Option.Option<ToolArtifact>, ToolArtifactStoreError>;

  upsert(artifact: ToolArtifact): Effect.Effect<void, ToolArtifactStoreError>;
}

export class ToolArtifactStoreService extends Context.Tag(
  "@executor-v2/persistence-ports/ToolArtifactStoreService",
)<ToolArtifactStoreService, ToolArtifactStore>() {}
