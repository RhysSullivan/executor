import { type SourceStoreError } from "@executor-v2/persistence-ports";
import {
  type SourceCredentialBinding,
  type SourceAuthBindingId,
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import type {
  RemoveCredentialBindingResult,
  UpsertCredentialBindingPayload,
} from "./api";

export type UpsertCredentialBindingInput = {
  workspaceId: WorkspaceId;
  payload: UpsertCredentialBindingPayload;
};

export type RemoveCredentialBindingInput = {
  workspaceId: WorkspaceId;
  credentialBindingId: SourceAuthBindingId;
};

export type ControlPlaneCredentialsServiceShape = {
  listCredentialBindings: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<SourceCredentialBinding>, SourceStoreError>;
  upsertCredentialBinding: (
    input: UpsertCredentialBindingInput,
  ) => Effect.Effect<SourceCredentialBinding, SourceStoreError>;
  removeCredentialBinding: (
    input: RemoveCredentialBindingInput,
  ) => Effect.Effect<RemoveCredentialBindingResult, SourceStoreError>;
};

export const makeControlPlaneCredentialsService = (
  service: ControlPlaneCredentialsServiceShape,
): ControlPlaneCredentialsServiceShape => service;
