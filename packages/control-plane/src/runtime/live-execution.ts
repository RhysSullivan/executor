import type {
  ElicitationResponse,
  OnElicitation,
} from "@executor-v3/codemode-core";
import { type SqlControlPlaneRows } from "#persistence";
import type {
  Execution,
  ExecutionInteraction,
} from "#schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

type VisibleExecutionState =
  | "waiting_for_interaction"
  | "completed"
  | "failed";

type LiveRunEntry = {
  stateWaiters: Array<Deferred.Deferred<VisibleExecutionState>>;
  currentInteraction: {
    interactionId: ExecutionInteraction["id"];
    response: Deferred.Deferred<ElicitationResponse>;
  } | null;
};

export type LiveExecutionManager = {
  registerStateWaiter: (
    executionId: Execution["id"],
  ) => Effect.Effect<Deferred.Deferred<VisibleExecutionState>>;
  createOnElicitation: (input: {
    rows: SqlControlPlaneRows;
    executionId: Execution["id"];
  }) => OnElicitation;
  resolveInteraction: (input: {
    executionId: Execution["id"];
    response: ElicitationResponse;
  }) => Effect.Effect<boolean>;
  finishRun: (input: {
    executionId: Execution["id"];
    state: Extract<VisibleExecutionState, "completed" | "failed">;
  }) => Effect.Effect<void>;
  clearRun: (executionId: Execution["id"]) => Effect.Effect<void>;
};

const createEmptyRun = (): LiveRunEntry => ({
  stateWaiters: [],
  currentInteraction: null,
});

const serializeJson = (value: unknown): string | null => {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
};

export const makeLiveExecutionManager = (): LiveExecutionManager => {
  const runs = new Map<Execution["id"], LiveRunEntry>();

  const getOrCreateRun = (executionId: Execution["id"]): LiveRunEntry => {
    const existing = runs.get(executionId);
    if (existing) {
      return existing;
    }

    const created = createEmptyRun();
    runs.set(executionId, created);
    return created;
  };

  const publishState = (input: {
    executionId: Execution["id"];
    state: VisibleExecutionState;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const run = getOrCreateRun(input.executionId);
      const waiters = [...run.stateWaiters];
      run.stateWaiters = [];

      yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, input.state), {
        discard: true,
      });
    });

  return {
    registerStateWaiter: (executionId) =>
      Effect.gen(function* () {
        const waiter = yield* Deferred.make<VisibleExecutionState>();
        const run = getOrCreateRun(executionId);
        run.stateWaiters.push(waiter);
        return waiter;
      }),

    createOnElicitation:
      ({ rows, executionId }) =>
      (input) =>
        Effect.gen(function* () {
          const run = getOrCreateRun(executionId);
          const response = yield* Deferred.make<ElicitationResponse>();
          const now = Date.now();
          const interaction: ExecutionInteraction = {
            id: `${executionId}:${input.interactionId}` as ExecutionInteraction["id"],
            executionId,
            status: "pending",
            kind: input.elicitation.mode === "url" ? "url" : "form",
            payloadJson:
              serializeJson({
                path: input.path,
                sourceKey: input.sourceKey,
                args: input.args,
                context: input.context,
                elicitation: input.elicitation,
              }) ?? "{}",
            responseJson: null,
            createdAt: now,
            updatedAt: now,
          };

          yield* rows.executionInteractions.insert(interaction);
          yield* rows.executions.update(executionId, {
            status: "waiting_for_interaction",
            updatedAt: now,
          });

          run.currentInteraction = {
            interactionId: interaction.id,
            response,
          };

          yield* publishState({
            executionId,
            state: "waiting_for_interaction",
          });

          const resolved = yield* Deferred.await(response);
          const resolvedAt = Date.now();

          yield* rows.executionInteractions.update(interaction.id, {
            status: resolved.action === "cancel" ? "cancelled" : "resolved",
            responseJson: serializeJson(resolved),
            updatedAt: resolvedAt,
          });
          yield* rows.executions.update(executionId, {
            status: "running",
            updatedAt: resolvedAt,
          });

          run.currentInteraction = null;
          return resolved;
        }),

    resolveInteraction: ({ executionId, response }) =>
      Effect.gen(function* () {
        const run = runs.get(executionId);
        const pending = run?.currentInteraction;
        if (!pending) {
          return false;
        }

        yield* Deferred.succeed(pending.response, response);
        return true;
      }),

    finishRun: ({ executionId, state }) =>
      publishState({ executionId, state }).pipe(
        Effect.zipRight(Effect.sync(() => {
          runs.delete(executionId);
        })),
      ),

    clearRun: (executionId) =>
      Effect.sync(() => {
        runs.delete(executionId);
      }),
  };
};
