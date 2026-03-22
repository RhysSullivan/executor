import type {
  AccountId,
  AuthArtifact,
  CredentialSlot,
  ProviderAuthGrant,
  Source,
  WorkspaceId,
} from "#schema";
import { decodeProviderGrantRefAuthArtifactConfig } from "#schema";
import * as Effect from "effect/Effect";

import { authArtifactSecretMaterialRefs } from "../../auth/auth-artifacts";
import { removeAuthLeaseAndSecrets } from "../../auth/auth-leases";
import type { DeleteSecretMaterial } from "../../workspace/secret-material-providers";
import type { ExecutorStateStoreShape } from "../../executor-state-store";

const secretRefKey = (ref: { providerId: string; handle: string }): string =>
  `${ref.providerId}:${ref.handle}`;

export const cleanupAuthArtifactSecretRefs = (
  executorState: ExecutorStateStoreShape,
  input: {
    previous: AuthArtifact | null;
    next: AuthArtifact | null;
  },
  deleteSecretMaterial: DeleteSecretMaterial,
) =>
  Effect.gen(function* () {
    if (input.previous === null) {
      return;
    }
    const nextRefKeys = new Set(
      (input.next === null ? [] : authArtifactSecretMaterialRefs(input.next)).map(
        secretRefKey,
      ),
    );
    const refsToDelete = authArtifactSecretMaterialRefs(input.previous).filter(
      (ref) => !nextRefKeys.has(secretRefKey(ref)),
    );

    yield* Effect.forEach(
      refsToDelete,
      (ref) => Effect.either(deleteSecretMaterial(ref)),
      { discard: true },
    );
  });

export const providerGrantIdsFromArtifacts = (
  artifacts: ReadonlyArray<
    Pick<AuthArtifact, "artifactKind" | "configJson"> | null
  >,
): ReadonlySet<ProviderAuthGrant["id"]> =>
  new Set(
    artifacts
      .flatMap((artifact) =>
        artifact ? [decodeProviderGrantRefAuthArtifactConfig(artifact)] : []
      )
      .flatMap((config) => (config ? [config.grantId] : [])),
  );

export const selectPreferredAuthArtifact = (input: {
  authArtifacts: ReadonlyArray<AuthArtifact>;
  actorAccountId?: AccountId | null;
  slot: CredentialSlot;
}): AuthArtifact | null => {
  const matchingSlot = input.authArtifacts.filter(
    (artifact) => artifact.slot === input.slot,
  );

  if (input.actorAccountId !== undefined) {
    const exact = matchingSlot.find(
      (artifact) => artifact.actorAccountId === input.actorAccountId,
    );
    if (exact) {
      return exact;
    }
  }

  return matchingSlot.find((artifact) => artifact.actorAccountId === null) ?? null;
};

export const selectExactAuthArtifact = (input: {
  authArtifacts: ReadonlyArray<AuthArtifact>;
  actorAccountId?: AccountId | null;
  slot: CredentialSlot;
}): AuthArtifact | null =>
  input.authArtifacts.find(
    (artifact) =>
      artifact.slot === input.slot &&
      artifact.actorAccountId === (input.actorAccountId ?? null),
  ) ?? null;

export const removeAuthArtifactsForSource = (
  executorState: ExecutorStateStoreShape,
  input: {
    workspaceId: WorkspaceId;
    sourceId: Source["id"];
  },
  deleteSecretMaterial: DeleteSecretMaterial,
) =>
  Effect.gen(function* () {
    const existingAuthArtifacts = yield* executorState.authArtifacts.listByWorkspaceAndSourceId({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });

    yield* executorState.authArtifacts.removeByWorkspaceAndSourceId({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });

    yield* Effect.forEach(
      existingAuthArtifacts,
      (artifact) =>
        removeAuthLeaseAndSecrets(executorState, {
          authArtifactId: artifact.id,
        }, deleteSecretMaterial),
      { discard: true },
    );

    yield* Effect.forEach(
      existingAuthArtifacts,
      (artifact) =>
        cleanupAuthArtifactSecretRefs(executorState, {
          previous: artifact,
          next: null,
        }, deleteSecretMaterial),
      { discard: true },
    );

    return existingAuthArtifacts.length;
  });
