import { type SourceStoreError } from "@executor-v2/persistence-ports";
import { type Workspace } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import type { UpsertWorkspacePayload } from "./api";

export type UpsertWorkspaceInput = {
  payload: UpsertWorkspacePayload;
};

export type ControlPlaneWorkspacesServiceShape = {
  listWorkspaces: () => Effect.Effect<ReadonlyArray<Workspace>, SourceStoreError>;
  upsertWorkspace: (
    input: UpsertWorkspaceInput,
  ) => Effect.Effect<Workspace, SourceStoreError>;
};

export const makeControlPlaneWorkspacesService = (
  service: ControlPlaneWorkspacesServiceShape,
): ControlPlaneWorkspacesServiceShape => service;
