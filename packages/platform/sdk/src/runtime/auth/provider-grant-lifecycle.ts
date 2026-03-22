import type {
  AuthArtifact,
  ProviderAuthGrant,
  WorkspaceId,
} from "#schema";
import {
  decodeProviderGrantRefAuthArtifactConfig,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  type DeleteSecretMaterial,
} from "../workspace/secret-material-providers";
import type { ExecutorStateStoreShape } from "../executor-state-store";

const providerGrantRefFromArtifact = (
  artifact: Pick<AuthArtifact, "artifactKind" | "configJson">,
) => decodeProviderGrantRefAuthArtifactConfig(artifact);

export const providerGrantIdFromArtifact = (
  artifact: Pick<AuthArtifact, "artifactKind" | "configJson">,
): ProviderAuthGrant["id"] | null =>
  providerGrantRefFromArtifact(artifact)?.grantId ?? null;

export const listProviderGrantRefArtifacts = (executorState: ExecutorStateStoreShape, input: {
  workspaceId: WorkspaceId;
  grantId?: ProviderAuthGrant["id"] | null;
}): Effect.Effect<readonly AuthArtifact[], Error, never> =>
  Effect.map(
    executorState.authArtifacts.listByWorkspaceId(input.workspaceId),
    (artifacts) =>
      artifacts.filter((artifact) => {
        const grantId = providerGrantIdFromArtifact(artifact);
        return grantId !== null && (input.grantId == null || grantId === input.grantId);
      }),
  );

export const clearProviderGrantOrphanedAt = (executorState: ExecutorStateStoreShape, input: {
  grantId: ProviderAuthGrant["id"];
}): Effect.Effect<boolean, Error, never> =>
  Effect.gen(function* () {
    const grantOption = yield* executorState.providerAuthGrants.getById(input.grantId);
    if (Option.isNone(grantOption) || grantOption.value.orphanedAt === null) {
      return false;
    }

    yield* executorState.providerAuthGrants.upsert({
      ...grantOption.value,
      orphanedAt: null,
      updatedAt: Date.now(),
    });
    return true;
  });

export const markProviderGrantOrphanedIfUnused = (executorState: ExecutorStateStoreShape, input: {
  workspaceId: WorkspaceId;
  grantId: ProviderAuthGrant["id"];
}): Effect.Effect<boolean, Error, never> =>
  Effect.gen(function* () {
    const references = yield* listProviderGrantRefArtifacts(executorState, input);
    if (references.length > 0) {
      return false;
    }

    const grantOption = yield* executorState.providerAuthGrants.getById(input.grantId);
    if (Option.isNone(grantOption) || grantOption.value.workspaceId !== input.workspaceId) {
      return false;
    }

    const grant = grantOption.value;
    if (grant.orphanedAt !== null) {
      return false;
    }

    yield* executorState.providerAuthGrants.upsert({
      ...grant,
      orphanedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return true;
  });

export const removeProviderAuthGrantSecret = (_executorState: ExecutorStateStoreShape, input: {
  grant: ProviderAuthGrant;
}, deleteSecretMaterial: DeleteSecretMaterial): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    yield* deleteSecretMaterial(input.grant.refreshToken).pipe(
      Effect.either,
      Effect.ignore,
    );
  });
