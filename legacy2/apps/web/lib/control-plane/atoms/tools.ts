import { Atom } from "@effect-atom/atom";
import type { SourceToolDetail } from "@executor-v2/management-api/tools/api";
import type { SourceToolSummary } from "@executor-v2/management-api/tools/api";
import type { SourceId, WorkspaceId } from "@executor-v2/schema";

import { controlPlaneClient } from "../client";
import { workspaceEntity, type EntityState } from "./entity";
import { toolDetailKeys, toolsKeys } from "./keys";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const workspaceToolsResultByWorkspace = Atom.family(
  (workspaceId: WorkspaceId) =>
    controlPlaneClient.query("tools", "listWorkspaceTools", {
      path: { workspaceId },
      reactivityKeys: toolsKeys(workspaceId),
    }),
);

export const sourceToolsResultBySource = Atom.family(
  (input: { workspaceId: WorkspaceId; sourceId: SourceId }) =>
    controlPlaneClient.query("tools", "listSourceTools", {
      path: { workspaceId: input.workspaceId, sourceId: input.sourceId },
      reactivityKeys: toolsKeys(input.workspaceId),
    }),
);

export const toolDetailResult = Atom.family(
  (input: { workspaceId: WorkspaceId; sourceId: SourceId; operationHash: string }) =>
    controlPlaneClient.query("tools", "getToolDetail", {
      path: {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        operationHash: input.operationHash,
      },
      reactivityKeys: toolDetailKeys(input.workspaceId),
    }),
);



// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

const sortTools = (a: SourceToolSummary, b: SourceToolSummary): number => {
  const aSource = a.sourceName.toLowerCase();
  const bSource = b.sourceName.toLowerCase();
  if (aSource !== bSource) return aSource.localeCompare(bSource);
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  if (aName !== bName) return aName.localeCompare(bName);
  return a.toolId.localeCompare(b.toolId);
};

export const workspaceToolsByWorkspace = workspaceEntity(
  workspaceToolsResultByWorkspace,
  sortTools,
);

export type SourceToolsState = EntityState<SourceToolSummary>;
