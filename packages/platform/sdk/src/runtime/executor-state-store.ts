import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  AuthArtifact,
  AuthLease,
  Execution,
  ExecutionInteraction,
  ExecutionStep,
  ProviderAuthGrant,
  SecretMaterial,
  SourceAuthSession,
  WorkspaceOauthClient,
  WorkspaceSourceOauthClient,
} from "#schema";

type SecretMaterialSummary = {
  id: string;
  providerId: string;
  name: string | null;
  purpose: string;
  createdAt: number;
  updatedAt: number;
};

export type ExecutorStateStoreShape = {
  authArtifacts: {
    listByWorkspaceId: (
      workspaceId: AuthArtifact["workspaceId"],
    ) => Effect.Effect<readonly AuthArtifact[], Error, never>;
    listByWorkspaceAndSourceId: (input: {
      workspaceId: AuthArtifact["workspaceId"];
      sourceId: AuthArtifact["sourceId"];
    }) => Effect.Effect<readonly AuthArtifact[], Error, never>;
    getByWorkspaceSourceAndActor: (input: {
      workspaceId: AuthArtifact["workspaceId"];
      sourceId: AuthArtifact["sourceId"];
      actorAccountId: AuthArtifact["actorAccountId"];
      slot: AuthArtifact["slot"];
    }) => Effect.Effect<import("effect/Option").Option<AuthArtifact>, Error, never>;
    upsert: (artifact: AuthArtifact) => Effect.Effect<void, Error, never>;
    removeByWorkspaceSourceAndActor: (input: {
      workspaceId: AuthArtifact["workspaceId"];
      sourceId: AuthArtifact["sourceId"];
      actorAccountId: AuthArtifact["actorAccountId"];
      slot?: AuthArtifact["slot"];
    }) => Effect.Effect<boolean, Error, never>;
    removeByWorkspaceAndSourceId: (input: {
      workspaceId: AuthArtifact["workspaceId"];
      sourceId: AuthArtifact["sourceId"];
    }) => Effect.Effect<number, Error, never>;
  };
  authLeases: {
    listAll: () => Effect.Effect<readonly AuthLease[], Error, never>;
    getByAuthArtifactId: (
      authArtifactId: AuthLease["authArtifactId"],
    ) => Effect.Effect<import("effect/Option").Option<AuthLease>, Error, never>;
    upsert: (lease: AuthLease) => Effect.Effect<void, Error, never>;
    removeByAuthArtifactId: (
      authArtifactId: AuthLease["authArtifactId"],
    ) => Effect.Effect<boolean, Error, never>;
  };
  sourceOauthClients: {
    getByWorkspaceSourceAndProvider: (input: {
      workspaceId: WorkspaceSourceOauthClient["workspaceId"];
      sourceId: WorkspaceSourceOauthClient["sourceId"];
      providerKey: string;
    }) => Effect.Effect<
      import("effect/Option").Option<WorkspaceSourceOauthClient>,
      Error,
      never
    >;
    upsert: (
      oauthClient: WorkspaceSourceOauthClient,
    ) => Effect.Effect<void, Error, never>;
    removeByWorkspaceAndSourceId: (input: {
      workspaceId: WorkspaceSourceOauthClient["workspaceId"];
      sourceId: WorkspaceSourceOauthClient["sourceId"];
    }) => Effect.Effect<number, Error, never>;
  };
  workspaceOauthClients: {
    listByWorkspaceAndProvider: (input: {
      workspaceId: WorkspaceOauthClient["workspaceId"];
      providerKey: string;
    }) => Effect.Effect<readonly WorkspaceOauthClient[], Error, never>;
    getById: (
      id: WorkspaceOauthClient["id"],
    ) => Effect.Effect<import("effect/Option").Option<WorkspaceOauthClient>, Error, never>;
    upsert: (oauthClient: WorkspaceOauthClient) => Effect.Effect<void, Error, never>;
    removeById: (id: WorkspaceOauthClient["id"]) => Effect.Effect<boolean, Error, never>;
  };
  providerAuthGrants: {
    listByWorkspaceId: (
      workspaceId: ProviderAuthGrant["workspaceId"],
    ) => Effect.Effect<readonly ProviderAuthGrant[], Error, never>;
    listByWorkspaceActorAndProvider: (input: {
      workspaceId: ProviderAuthGrant["workspaceId"];
      actorAccountId: ProviderAuthGrant["actorAccountId"];
      providerKey: string;
    }) => Effect.Effect<readonly ProviderAuthGrant[], Error, never>;
    getById: (
      id: ProviderAuthGrant["id"],
    ) => Effect.Effect<import("effect/Option").Option<ProviderAuthGrant>, Error, never>;
    upsert: (grant: ProviderAuthGrant) => Effect.Effect<void, Error, never>;
    removeById: (id: ProviderAuthGrant["id"]) => Effect.Effect<boolean, Error, never>;
  };
  sourceAuthSessions: {
    listAll: () => Effect.Effect<readonly SourceAuthSession[], Error, never>;
    listByWorkspaceId: (
      workspaceId: SourceAuthSession["workspaceId"],
    ) => Effect.Effect<readonly SourceAuthSession[], Error, never>;
    getById: (
      id: SourceAuthSession["id"],
    ) => Effect.Effect<import("effect/Option").Option<SourceAuthSession>, Error, never>;
    getByState: (
      state: SourceAuthSession["state"],
    ) => Effect.Effect<import("effect/Option").Option<SourceAuthSession>, Error, never>;
    getPendingByWorkspaceSourceAndActor: (input: {
      workspaceId: SourceAuthSession["workspaceId"];
      sourceId: SourceAuthSession["sourceId"];
      actorAccountId: SourceAuthSession["actorAccountId"];
      credentialSlot?: SourceAuthSession["credentialSlot"];
    }) => Effect.Effect<
      import("effect/Option").Option<SourceAuthSession>,
      Error,
      never
    >;
    insert: (session: SourceAuthSession) => Effect.Effect<void, Error, never>;
    update: (
      id: SourceAuthSession["id"],
      patch: Partial<
        Omit<SourceAuthSession, "id" | "workspaceId" | "sourceId" | "createdAt">
      >,
    ) => Effect.Effect<import("effect/Option").Option<SourceAuthSession>, Error, never>;
    upsert: (session: SourceAuthSession) => Effect.Effect<void, Error, never>;
    removeByWorkspaceAndSourceId: (
      workspaceId: SourceAuthSession["workspaceId"],
      sourceId: SourceAuthSession["sourceId"],
    ) => Effect.Effect<boolean, Error, never>;
  };
  secretMaterials: {
    getById: (
      id: SecretMaterial["id"],
    ) => Effect.Effect<import("effect/Option").Option<SecretMaterial>, Error, never>;
    listAll: () => Effect.Effect<readonly SecretMaterialSummary[], Error, never>;
    upsert: (material: SecretMaterial) => Effect.Effect<void, Error, never>;
    updateById: (
      id: SecretMaterial["id"],
      update: { name?: string | null; value?: string },
    ) => Effect.Effect<
      import("effect/Option").Option<SecretMaterialSummary>,
      Error,
      never
    >;
    removeById: (id: SecretMaterial["id"]) => Effect.Effect<boolean, Error, never>;
  };
  executions: {
    getById: (
      executionId: Execution["id"],
    ) => Effect.Effect<import("effect/Option").Option<Execution>, Error, never>;
    getByWorkspaceAndId: (
      workspaceId: Execution["workspaceId"],
      executionId: Execution["id"],
    ) => Effect.Effect<import("effect/Option").Option<Execution>, Error, never>;
    insert: (execution: Execution) => Effect.Effect<void, Error, never>;
    update: (
      executionId: Execution["id"],
      patch: Partial<
        Omit<Execution, "id" | "workspaceId" | "createdByAccountId" | "createdAt">
      >,
    ) => Effect.Effect<import("effect/Option").Option<Execution>, Error, never>;
  };
  executionInteractions: {
    getById: (
      interactionId: ExecutionInteraction["id"],
    ) => Effect.Effect<
      import("effect/Option").Option<ExecutionInteraction>,
      Error,
      never
    >;
    listByExecutionId: (
      executionId: ExecutionInteraction["executionId"],
    ) => Effect.Effect<readonly ExecutionInteraction[], Error, never>;
    getPendingByExecutionId: (
      executionId: ExecutionInteraction["executionId"],
    ) => Effect.Effect<
      import("effect/Option").Option<ExecutionInteraction>,
      Error,
      never
    >;
    insert: (
      interaction: ExecutionInteraction,
    ) => Effect.Effect<void, Error, never>;
    update: (
      interactionId: ExecutionInteraction["id"],
      patch: Partial<
        Omit<ExecutionInteraction, "id" | "executionId" | "createdAt">
      >,
    ) => Effect.Effect<
      import("effect/Option").Option<ExecutionInteraction>,
      Error,
      never
    >;
  };
  executionSteps: {
    getByExecutionAndSequence: (
      executionId: ExecutionStep["executionId"],
      sequence: ExecutionStep["sequence"],
    ) => Effect.Effect<import("effect/Option").Option<ExecutionStep>, Error, never>;
    listByExecutionId: (
      executionId: ExecutionStep["executionId"],
    ) => Effect.Effect<readonly ExecutionStep[], Error, never>;
    insert: (step: ExecutionStep) => Effect.Effect<void, Error, never>;
    deleteByExecutionId: (
      executionId: ExecutionStep["executionId"],
    ) => Effect.Effect<void, Error, never>;
    updateByExecutionAndSequence: (
      executionId: ExecutionStep["executionId"],
      sequence: ExecutionStep["sequence"],
      patch: Partial<
        Omit<ExecutionStep, "id" | "executionId" | "sequence" | "createdAt">
      >,
    ) => Effect.Effect<import("effect/Option").Option<ExecutionStep>, Error, never>;
  };
};

export class ExecutorStateStore extends Context.Tag(
  "#runtime/ExecutorStateStore",
)<ExecutorStateStore, ExecutorStateStoreShape>() {}
