import { type SourceStoreError } from "@executor-v2/persistence-ports";
import { type SourceId, type WorkspaceId } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import type { SourceToolDetail, SourceToolSummary } from "./api";

export type ListSourceToolsInput = {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
};

export type GetToolDetailInput = {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  operationHash: string;
};

export type ControlPlaneToolsServiceShape = {
  listWorkspaceTools: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<SourceToolSummary>, SourceStoreError>;
  listSourceTools: (
    input: ListSourceToolsInput,
  ) => Effect.Effect<ReadonlyArray<SourceToolSummary>, SourceStoreError>;
  getToolDetail: (
    input: GetToolDetailInput,
  ) => Effect.Effect<SourceToolDetail | null, SourceStoreError>;
};

export const makeControlPlaneToolsService = (
  service: ControlPlaneToolsServiceShape,
): ControlPlaneToolsServiceShape => service;
