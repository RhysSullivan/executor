import type {
  ElicitationResponse,
  OnElicitation,
} from "@executor/codemode-core";
import { clearMcpConnectionPoolRun } from "@executor/source-mcp";
import {
  ExecutionInteractionIdSchema,
  type Execution,
  type ExecutionInteraction,
} from "#schema";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ExecutorStateStoreShape } from "../executor-state-store";

type VisibleExecutionState =
  | "running"
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

type LiveExecutionManagerShape = {
  publishState: (input: {
    executionId: Execution["id"];
    state: VisibleExecutionState;
  }) => Effect.Effect<void>;
  registerStateWaiter: (
    executionId: Execution["id"],
  ) => Effect.Effect<Deferred.Deferred<VisibleExecutionState>>;
  createOnElicitation: (input: {
    executorState: ExecutorStateStoreShape;
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

const SENSITIVE_INTERACTION_CONTENT_KEYS = new Set([
  "tokenRef",
  "tokenSecretMaterialId",
]);

const redactSensitiveInteractionContent = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveInteractionContent);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_INTERACTION_CONTENT_KEYS.has(key))
    .map(([key, entry]) => [key, redactSensitiveInteractionContent(entry)]);

  return Object.fromEntries(entries);
};

export const sanitizePersistedElicitationResponse = (
  response: ElicitationResponse,
): ElicitationResponse => {
  if (response.content === undefined) {
    return response;
  }

  const redactedContent = redactSensitiveInteractionContent(response.content);
  return {
    ...response,
    content: redactedContent as Record<string, unknown>,
  };
};

const interactionPurposeFromInput = (input: Parameters<OnElicitation>[0]): string => {
  const explicitPurpose = input.context?.interactionPurpose;
  if (typeof explicitPurpose === "string" && explicitPurpose.length > 0) {
    return explicitPurpose;
  }

  if (input.path === "executor.sources.add") {
    return input.elicitation.mode === "url"
      ? "source_connect_oauth2"
      : "source_connect_secret";
  }

  return "elicitation";
};


export const createLiveExecutionManager = () => {
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

  const manager = {
    publishState,

    registerStateWaiter: (executionId) =>
      Effect.gen(function* () {
        const waiter = yield* Deferred.make<VisibleExecutionState>();
        const run = getOrCreateRun(executionId);
        run.stateWaiters.push(waiter);
        return waiter;
      }),

    createOnElicitation:
      ({ executorState, executionId }) =>
      (input) =>
        Effect.gen(function* () {
          const run = getOrCreateRun(executionId);
          const response = yield* Deferred.make<ElicitationResponse>();
          const now = Date.now();
          const interaction: ExecutionInteraction = {
            id: ExecutionInteractionIdSchema.make(`${executionId}:${input.interactionId}`),
            executionId,
            status: "pending",
            kind: input.elicitation.mode === "url" ? "url" : "form",
            purpose: interactionPurposeFromInput(input),
            payloadJson:
              serializeJson({
                path: input.path,
                sourceKey: input.sourceKey,
                args: input.args,
                context: input.context,
                elicitation: input.elicitation,
              }) ?? "{}",
            responseJson: null,
            responsePrivateJson: null,
            createdAt: now,
            updatedAt: now,
          };

          yield* executorState.executionInteractions.insert(interaction);
          yield* executorState.executions.update(executionId, {
            status: "waiting_for_interaction",
            updatedAt: now,
          });

          run.currentInteraction = {
            interactionId: interaction.id,
            response,
          };

          return yield* Effect.gen(function* () {
            yield* publishState({
              executionId,
              state: "waiting_for_interaction",
            });

            const resolved = yield* Deferred.await(response);
            const resolvedAt = Date.now();

            yield* executorState.executionInteractions.update(interaction.id, {
              status: resolved.action === "cancel" ? "cancelled" : "resolved",
              responseJson: serializeJson(sanitizePersistedElicitationResponse(resolved)),
              responsePrivateJson: serializeJson(resolved),
              updatedAt: resolvedAt,
            });
            yield* executorState.executions.update(executionId, {
              status: "running",
              updatedAt: resolvedAt,
            });
            yield* publishState({
              executionId,
              state: "running",
            });

            return resolved;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (run.currentInteraction?.interactionId === interaction.id) {
                  run.currentInteraction = null;
                }
              }),
            ),
          );
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
        Effect.zipRight(clearMcpConnectionPoolRun(executionId)),
        Effect.ensuring(
          Effect.sync(() => {
            runs.delete(executionId);
          }),
        ),
      ),

    clearRun: (executionId) =>
      clearMcpConnectionPoolRun(executionId).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            runs.delete(executionId);
          }),
        ),
      ),
  } satisfies LiveExecutionManagerShape;

  return manager;
};

export type LiveExecutionManager = ReturnType<typeof createLiveExecutionManager>;

export class LiveExecutionManagerService extends Context.Tag(
  "#runtime/LiveExecutionManagerService",
)<LiveExecutionManagerService, ReturnType<typeof createLiveExecutionManager>>() {}

export const LiveExecutionManagerLive = Layer.sync(
  LiveExecutionManagerService,
  createLiveExecutionManager,
);
