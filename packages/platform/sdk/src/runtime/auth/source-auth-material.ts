import type {
  AccountId,
  CredentialSlot,
  Source,
  SourceAuth,
} from "#schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ExecutorStateStore, type ExecutorStateStoreShape } from "../executor-state-store";
import {
  authArtifactFromSourceAuth,
  resolveAuthArtifactMaterial,
  type ResolvedSourceAuthMaterial,
} from "./auth-artifacts";
import { resolveAuthArtifactMaterialWithLeases } from "./auth-leases";
import type {
  DeleteSecretMaterial,
  ResolveSecretMaterial,
  SecretMaterialResolveContext,
  StoreSecretMaterial,
} from "../workspace/secret-material-providers";
import {
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
} from "../workspace/secret-material-providers";
import { runtimeEffectError } from "../effect-errors";

const authForSlot = (input: {
  source: Source;
  slot: CredentialSlot;
}): SourceAuth => {
  if (input.slot === "runtime") {
    return input.source.auth;
  }

  if (input.source.importAuthPolicy === "reuse_runtime") {
    return input.source.auth;
  }

  if (input.source.importAuthPolicy === "none") {
    return { kind: "none" };
  }

  return input.source.importAuth;
};

export type RuntimeSourceAuthMaterialShape = {
  resolve: (input: {
    source: Source;
    slot?: CredentialSlot;
    actorAccountId?: AccountId | null;
    context?: SecretMaterialResolveContext;
  }) => Effect.Effect<ResolvedSourceAuthMaterial, Error, never>;
};

export class RuntimeSourceAuthMaterialService extends Context.Tag(
  "#runtime/RuntimeSourceAuthMaterialService",
)<RuntimeSourceAuthMaterialService, RuntimeSourceAuthMaterialShape>() {}

export const resolveSourceAuthMaterialWithDeps = (input: {
  source: Source;
  slot?: CredentialSlot;
  actorAccountId?: AccountId | null;
  executorState?: ExecutorStateStoreShape;
  resolveSecretMaterial: ResolveSecretMaterial;
  storeSecretMaterial?: StoreSecretMaterial;
  deleteSecretMaterial?: DeleteSecretMaterial;
  context?: SecretMaterialResolveContext;
}): Effect.Effect<ResolvedSourceAuthMaterial, Error, never> =>
  Effect.gen(function* () {
    const slot = input.slot ?? "runtime";

    if (input.executorState !== undefined) {
      const candidateSlots =
        slot === "import" && input.source.importAuthPolicy === "reuse_runtime"
          ? ["import", "runtime"] satisfies ReadonlyArray<CredentialSlot>
          : [slot] satisfies ReadonlyArray<CredentialSlot>;

      for (const candidateSlot of candidateSlots) {
        const artifactOption = yield* input.executorState.authArtifacts.getByWorkspaceSourceAndActor({
          workspaceId: input.source.workspaceId,
          sourceId: input.source.id,
          actorAccountId: input.actorAccountId ?? null,
          slot: candidateSlot,
        });

        if (Option.isSome(artifactOption)) {
          return yield* resolveAuthArtifactMaterialWithLeases({
            executorState: input.executorState,
            artifact: artifactOption.value,
            resolveSecretMaterial: input.resolveSecretMaterial,
            storeSecretMaterial: input.storeSecretMaterial ?? (() => Effect.dieMessage("storeSecretMaterial unavailable")),
            deleteSecretMaterial: input.deleteSecretMaterial ?? (() => Effect.dieMessage("deleteSecretMaterial unavailable")),
            context: input.context,
          });
        }
      }
    }

    const artifact = authArtifactFromSourceAuth({
      source: input.source,
      auth: authForSlot({
        source: input.source,
        slot,
      }),
      slot,
      actorAccountId: input.actorAccountId ?? null,
    });

    if (input.executorState !== undefined) {
      return yield* resolveAuthArtifactMaterialWithLeases({
        executorState: input.executorState,
        artifact,
        resolveSecretMaterial: input.resolveSecretMaterial,
        storeSecretMaterial: input.storeSecretMaterial ?? (() => Effect.dieMessage("storeSecretMaterial unavailable")),
        deleteSecretMaterial: input.deleteSecretMaterial ?? (() => Effect.dieMessage("deleteSecretMaterial unavailable")),
        context: input.context,
      });
    }

    if (
      artifact?.artifactKind === "oauth2_authorized_user"
      || artifact?.artifactKind === "provider_grant_ref"
      || artifact?.artifactKind === "mcp_oauth"
    ) {
      return yield* runtimeEffectError("auth/source-auth-material", "Dynamic auth artifacts require persistence-backed lease resolution");
    }

    return yield* resolveAuthArtifactMaterial({
      artifact,
      resolveSecretMaterial: input.resolveSecretMaterial,
      context: input.context,
    });
  });

export const resolveSourceAuthMaterial = (input: {
  source: Source;
  slot?: CredentialSlot;
  actorAccountId?: AccountId | null;
  context?: SecretMaterialResolveContext;
}): Effect.Effect<ResolvedSourceAuthMaterial, Error, RuntimeSourceAuthMaterialService> =>
  Effect.flatMap(RuntimeSourceAuthMaterialService, (service) => service.resolve(input));

export const RuntimeSourceAuthMaterialLive = Layer.effect(
  RuntimeSourceAuthMaterialService,
  Effect.gen(function* () {
    const executorState = yield* ExecutorStateStore;
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    const storeSecretMaterial = yield* SecretMaterialStorerService;
    const deleteSecretMaterial = yield* SecretMaterialDeleterService;

    return RuntimeSourceAuthMaterialService.of({
      resolve: (input) =>
        resolveSourceAuthMaterialWithDeps({
          ...input,
          executorState,
          resolveSecretMaterial,
          storeSecretMaterial,
          deleteSecretMaterial,
        }),
    });
  }),
);

export type { ResolvedSourceAuthMaterial } from "./auth-artifacts";
