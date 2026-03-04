import { type SourceStoreError } from "@executor-v2/persistence-ports";
import {
  type Interaction,
  type InteractionId,
  type TaskRunId,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import type { ResolveInteractionPayload } from "./api";

export type ResolveInteractionInput = {
  workspaceId: WorkspaceId;
  interactionId: InteractionId;
  payload: ResolveInteractionPayload;
};

export type ListRunInteractionsInput = {
  workspaceId: WorkspaceId;
  runId: TaskRunId;
};

export type GetInteractionInput = {
  workspaceId: WorkspaceId;
  interactionId: InteractionId;
};

export type ControlPlaneInteractionsServiceShape = {
  listInteractions: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Interaction>, SourceStoreError>;
  listRunInteractions: (
    input: ListRunInteractionsInput,
  ) => Effect.Effect<ReadonlyArray<Interaction>, SourceStoreError>;
  getInteraction: (
    input: GetInteractionInput,
  ) => Effect.Effect<Interaction, SourceStoreError>;
  resolveInteraction: (
    input: ResolveInteractionInput,
  ) => Effect.Effect<Interaction, SourceStoreError>;
};

export const makeControlPlaneInteractionsService = (
  service: ControlPlaneInteractionsServiceShape,
): ControlPlaneInteractionsServiceShape => service;
