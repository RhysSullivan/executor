import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  Execution,
  ExecutionInteraction,
  ExecutionStep,
  SecretMaterial,
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
    listByScope: (
      scopeId: Execution["scopeId"],
    ) => Effect.Effect<readonly Execution[], Error, never>;
    getById: (
      executionId: Execution["id"],
    ) => Effect.Effect<import("effect/Option").Option<Execution>, Error, never>;
    getByScopeAndId: (
      scopeId: Execution["scopeId"],
      executionId: Execution["id"],
    ) => Effect.Effect<import("effect/Option").Option<Execution>, Error, never>;
    insert: (execution: Execution) => Effect.Effect<void, Error, never>;
    update: (
      executionId: Execution["id"],
      patch: Partial<
        Omit<Execution, "id" | "scopeId" | "createdByScopeId" | "createdAt">
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
