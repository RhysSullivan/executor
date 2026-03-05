import { type SourceStoreError } from "@executor-v2/persistence-ports";
import {
  SourceCatalogValidationError,
  type SourceCatalogService,
} from "../source-catalog";
import { type Source, type SourceId, type WorkspaceId } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import type { RemoveSourceResult, UpsertSourcePayload } from "./api";

export type UpsertSourceInput = {
  workspaceId: WorkspaceId;
  payload: UpsertSourcePayload;
};

export type RemoveSourceInput = {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
};

export type ControlPlaneSourcesServiceShape = {
  listSources: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Source>, SourceStoreError>;
  upsertSource: (
    input: UpsertSourceInput,
  ) => Effect.Effect<Source, SourceStoreError | SourceCatalogValidationError>;
  removeSource: (input: RemoveSourceInput) => Effect.Effect<RemoveSourceResult, SourceStoreError>;
};

export const makeControlPlaneSourcesService = (
  sourceCatalog: SourceCatalogService,
): ControlPlaneSourcesServiceShape => ({
  listSources: (workspaceId) => sourceCatalog.listSources(workspaceId),
  upsertSource: (input) =>
    sourceCatalog.upsertSource({
      workspaceId: input.workspaceId,
      payload: input.payload,
    }),
  removeSource: (input) =>
    sourceCatalog.removeSource({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    }),
});
