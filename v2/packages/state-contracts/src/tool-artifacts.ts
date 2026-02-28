import type { SourceId, ToolArtifact, WorkspaceId } from "@executor-v2/schema";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

export interface ToolArtifactStore {
  getBySource(
    workspaceId: WorkspaceId,
    sourceId: SourceId,
  ): Effect.Effect<Option.Option<ToolArtifact>>;

  upsert(artifact: ToolArtifact): Effect.Effect<void>;
}
