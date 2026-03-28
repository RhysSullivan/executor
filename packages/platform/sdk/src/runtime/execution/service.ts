import {
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
} from "../../errors";
import type {
  ElicitationResponse,
  OnElicitation,
  ToolInvocationContext,
  ToolInvoker,
} from "@executor/codemode-core";
import type {
  CreateExecutionPayload,
  ResumeExecutionPayload,
} from "../../executions/contracts";
import {
  ExecutionIdSchema,
  ExecutionInteractionIdSchema,
  ExecutionStepIdSchema,
  type ScopeId,
  type Execution,
  type ExecutionEnvelope,
  type ExecutionId,
  type ExecutionInteraction,
} from "#schema";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type ResolveExecutionEnvironment,
} from "./state";
import {
  LiveExecutionManagerService,
  sanitizePersistedElicitationResponse,
  type LiveExecutionManager,
} from "./live";
import {
  getRuntimeLocalScopeOption,
  provideOptionalRuntimeLocalScope,
} from "../scope/runtime-context";
import {
  asOperationErrors,
  operationErrors,
  type OperationErrorsLike,
} from "../policy/operation-errors";
import {
  ExecutorStateStore,
  type ExecutorStateStoreShape,
} from "../executor-state-store";
import {
  RuntimeExecutionResolverService,
} from "./scope/environment";
import {
  runtimeEffectError,
} from "../effect-errors";

const executionOps = {
  create: operationErrors("executions.create"),
  list: operationErrors("executions.list"),
  get: operationErrors("executions.get"),
  resume: operationErrors("executions.resume"),
} as const;

type InteractionMode = NonNullable<CreateExecutionPayload["interactionMode"]>;

const EXECUTION_SUSPENDED_SENTINEL = "__EXECUTION_SUSPENDED__";

const DEFAULT_INTERACTION_MODE: InteractionMode = "detach";

const serializeJson = (value: unknown): string | null => {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
};

const serializeRequiredJson = (value: unknown): string =>
  JSON.stringify(value === undefined ? null : value);

const parseStoredJson = (value: string | null): unknown => {
  if (value === null) {
    return undefined;
  }

  return JSON.parse(value);
};

const ElicitationActionSchema = Schema.Literal("accept", "decline", "cancel");

const ElicitationResponseSchema = Schema.Struct({
  action: ElicitationActionSchema,
  content: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
  ),
});

const decodeElicitationResponse = Schema.decodeUnknown(ElicitationResponseSchema);

const withExecutionInvocationContext = (input: {
  executionId: Execution["id"];
  toolInvoker: ToolInvoker;
}): ToolInvoker => {
  let sequence = 0;

  return {
    invoke: ({ path, args, context }) => {
      sequence += 1;

      return input.toolInvoker.invoke({
        path,
        args,
        context: {
          ...context,
          runId: input.executionId,
          callId:
            typeof context?.callId === "string" && context.callId.length > 0
              ? context.callId
              : `call_${String(sequence)}`,
          executionStepSequence: sequence,
        },
      });
    },
  };
};

const executionStepSequenceFromContext = (
  context: ToolInvocationContext | undefined,
): number | null => {
  const value = context?.executionStepSequence;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
};

const executionStepIdFor = (
  executionId: Execution["id"],
  sequence: number,
) => ExecutionStepIdSchema.make(`${executionId}:step:${String(sequence)}`);

const interactionIdSuffixForRequest = (input: {
  interactionId: string;
  path: string;
  context?: ToolInvocationContext;
}) => {
  const callId =
    typeof input.context?.callId === "string" && input.context.callId.length > 0
      ? input.context.callId
      : null;

  return callId === null ? input.interactionId : `${callId}:${input.path}`;
};

const executionInteractionIdForRequest = (input: {
  executionId: Execution["id"];
  interactionId: string;
  path: string;
  context?: ToolInvocationContext;
}) => {
  return ExecutionInteractionIdSchema.make(
    `${input.executionId}:${interactionIdSuffixForRequest(input)}`,
  );
};

const resolveInteractionMode = (
  value: CreateExecutionPayload["interactionMode"] | ResumeExecutionPayload["interactionMode"],
): InteractionMode =>
  value === "live" || value === "live_form" ? value : DEFAULT_INTERACTION_MODE;

class ExecutionSuspendedError extends Data.TaggedError(
  "ExecutionSuspendedError",
)<{
  readonly executionId: Execution["id"];
  readonly interactionId: string;
  readonly message: string;
}> {}

const createExecutionSuspendedError = (input: {
  executionId: Execution["id"];
  interactionId: string;
}): ExecutionSuspendedError =>
  new ExecutionSuspendedError({
    executionId: input.executionId,
    interactionId: input.interactionId,
    message: `${EXECUTION_SUSPENDED_SENTINEL}:${input.executionId}:${input.interactionId}`,
  });

const isExecutionSuspendedValue = (value: unknown): boolean => {
  if (value instanceof ExecutionSuspendedError) {
    return true;
  }

  if (value instanceof Error) {
    return value.message.includes(EXECUTION_SUSPENDED_SENTINEL);
  }

  return typeof value === "string" && value.includes(EXECUTION_SUSPENDED_SENTINEL);
};

const decodeStoredElicitationResponse = (input: {
  interactionId: string;
  responseJson: string | null;
}) =>
  Effect.try({
    try: () => {
      if (input.responseJson === null) {
        throw new Error(
          `Interaction ${input.interactionId} has no stored response`,
        );
      }

      return JSON.parse(input.responseJson);
    },
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  }).pipe(
    Effect.flatMap((decoded) =>
      decodeElicitationResponse(decoded).pipe(
        Effect.mapError((error) => new Error(String(error))),
      )
    ),
  );

const verifyStoredStepMatches = (input: {
  executionId: Execution["id"];
  sequence: number;
  expectedPath: string;
  expectedArgsJson: string;
  actualPath: string;
  actualArgsJson: string;
}) => {
  if (
    input.expectedPath === input.actualPath
    && input.expectedArgsJson === input.actualArgsJson
  ) {
    return;
  }

  throw new Error(
    [
      `Durable execution mismatch for ${input.executionId} at tool step ${String(input.sequence)}.`,
      `Expected ${input.expectedPath}(${input.expectedArgsJson}) but replay reached ${input.actualPath}(${input.actualArgsJson}).`,
    ].join(" "),
  );
};

const fetchExecution = (
  store: ExecutorStateStoreShape,
  input: {
    scopeId: Execution["scopeId"];
    executionId: Execution["id"];
    operation: OperationErrorsLike;
  },
): Effect.Effect<Execution, ControlPlaneNotFoundError | ControlPlaneStorageError> =>
  Effect.gen(function* () {
    const errors = asOperationErrors(input.operation);
    const existing = yield* errors.mapStorage(
      store.executions.getByScopeAndId(input.scopeId, input.executionId),
    );

    if (Option.isNone(existing)) {
      return yield* errors.notFound(
          "Execution not found",
          `scopeId=${input.scopeId} executionId=${input.executionId}`,
        );
    }

    return existing.value;
  });

const fetchExecutionEnvelope = (
  store: ExecutorStateStoreShape,
  input: {
    scopeId: Execution["scopeId"];
    executionId: Execution["id"];
    operation: OperationErrorsLike;
  },
): Effect.Effect<ExecutionEnvelope, ControlPlaneNotFoundError | ControlPlaneStorageError> =>
  Effect.gen(function* () {
    const errors = asOperationErrors(input.operation);
    const execution = yield* fetchExecution(store, input);
    const pendingInteraction = yield* errors.child("pending_interaction").mapStorage(
      store.executionInteractions.getPendingByExecutionId(input.executionId),
    );

    return {
      execution,
      pendingInteraction: Option.isSome(pendingInteraction) ? pendingInteraction.value : null,
    };
  });

const waitForExecutionEnvelopeToSettle = (
  store: ExecutorStateStoreShape,
  input: {
    scopeId: Execution["scopeId"];
    executionId: Execution["id"];
    operation: OperationErrorsLike;
    previousPendingInteractionId: ExecutionInteraction["id"] | null;
    attemptsRemaining: number;
  },
): Effect.Effect<ExecutionEnvelope, ControlPlaneNotFoundError | ControlPlaneStorageError, never> =>
  Effect.gen(function* () {
    const envelope = yield* fetchExecutionEnvelope(store, input);
    if (
      (
        envelope.execution.status !== "running"
        && !(
          envelope.execution.status === "waiting_for_interaction"
          && (
            envelope.pendingInteraction === null
            || envelope.pendingInteraction.id === input.previousPendingInteractionId
          )
        )
      )
      || input.attemptsRemaining <= 0
    ) {
      return envelope;
    }

    yield* Effect.promise(
      () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
    );
    return yield* waitForExecutionEnvelopeToSettle(store, {
      ...input,
      attemptsRemaining: input.attemptsRemaining - 1,
    });
  });

const suspendExecutionForInteraction = (input: {
  executorState: ExecutorStateStoreShape;
  executionId: Execution["id"];
  liveExecutionManager: LiveExecutionManager;
  request: Parameters<OnElicitation>[0];
  interactionId: ExecutionEnvelope["pendingInteraction"] extends infer T
    ? T extends { id: infer I }
      ? I
      : never
    : never;
}) =>
  Effect.gen(function* () {
    const now = Date.now();
    const existing = yield* input.executorState.executionInteractions.getById(input.interactionId);
    const stepSequence = executionStepSequenceFromContext(input.request.context);

    if (Option.isSome(existing) && existing.value.status !== "pending") {
      return yield* decodeStoredElicitationResponse({
        interactionId: input.interactionId,
        responseJson:
          existing.value.responsePrivateJson ?? existing.value.responseJson,
      });
    }

    if (Option.isNone(existing)) {
      yield* input.executorState.executionInteractions.insert({
        id: ExecutionInteractionIdSchema.make(input.interactionId),
        executionId: input.executionId,
        status: "pending",
        kind: input.request.elicitation.mode === "url" ? "url" : "form",
        purpose: "elicitation",
        payloadJson:
          serializeJson({
            path: input.request.path,
            sourceKey: input.request.sourceKey,
            args: input.request.args,
            context: input.request.context,
            elicitation: input.request.elicitation,
          }) ?? "{}",
        responseJson: null,
        responsePrivateJson: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (stepSequence !== null) {
      yield* input.executorState.executionSteps.updateByExecutionAndSequence(
        input.executionId,
        stepSequence,
        {
          status: "waiting",
          interactionId: ExecutionInteractionIdSchema.make(input.interactionId),
          updatedAt: now,
        },
      );
    }

    yield* input.executorState.executions.update(input.executionId, {
      status: "waiting_for_interaction",
      updatedAt: now,
    });
    yield* input.liveExecutionManager.publishState({
      executionId: input.executionId,
      state: "waiting_for_interaction",
    });

    return yield* createExecutionSuspendedError({
        executionId: input.executionId,
        interactionId: input.interactionId,
      });
  });

const createHybridOnElicitation = (input: {
  executorState: ExecutorStateStoreShape;
  executionId: Execution["id"];
  liveExecutionManager: LiveExecutionManager;
  interactionMode: InteractionMode;
}): OnElicitation => {
  const liveOnElicitation = input.liveExecutionManager.createOnElicitation({
    executorState: input.executorState,
    executionId: input.executionId,
  });

  return (request) =>
    Effect.gen(function* () {
      const interactionIdSuffix = interactionIdSuffixForRequest({
        interactionId: request.interactionId,
        path: request.path,
        context: request.context,
      });
      const interactionId = executionInteractionIdForRequest({
        executionId: input.executionId,
        interactionId: request.interactionId,
        path: request.path,
        context: request.context,
      });
      const existing = yield* input.executorState.executionInteractions.getById(interactionId);

      if (Option.isSome(existing) && existing.value.status !== "pending") {
        return yield* decodeStoredElicitationResponse({
          interactionId,
          responseJson:
            existing.value.responsePrivateJson ?? existing.value.responseJson,
        });
      }

      const allowLiveWait =
        input.interactionMode === "live"
        || (input.interactionMode === "live_form" && request.elicitation.mode !== "url");

      if (Option.isNone(existing) && allowLiveWait) {
        const stepSequence = executionStepSequenceFromContext(request.context);
        if (stepSequence !== null) {
          yield* input.executorState.executionSteps.updateByExecutionAndSequence(
            input.executionId,
            stepSequence,
            {
              status: "waiting",
              interactionId: ExecutionInteractionIdSchema.make(interactionId),
              updatedAt: Date.now(),
            },
          );
        }

        return yield* liveOnElicitation({
          ...request,
          interactionId: interactionIdSuffix,
        });
      }

      return yield* suspendExecutionForInteraction({
        executorState: input.executorState,
        executionId: input.executionId,
        liveExecutionManager: input.liveExecutionManager,
        request,
        interactionId,
      });
    });
};

const createReplayToolInvoker = (input: {
  executorState: ExecutorStateStoreShape;
  executionId: Execution["id"];
  toolInvoker: ToolInvoker;
}): ToolInvoker => ({
  invoke: ({ path, args, context }) =>
    Effect.gen(function* () {
      const stepSequence = executionStepSequenceFromContext(context);
      if (stepSequence === null) {
        return yield* input.toolInvoker.invoke({ path, args, context });
      }

      const argsJson = serializeRequiredJson(args);
      const existing = yield* input.executorState.executionSteps.getByExecutionAndSequence(
        input.executionId,
        stepSequence,
      );

      if (Option.isSome(existing)) {
        verifyStoredStepMatches({
          executionId: input.executionId,
          sequence: stepSequence,
          expectedPath: existing.value.path,
          expectedArgsJson: existing.value.argsJson,
          actualPath: path,
          actualArgsJson: argsJson,
        });

        if (existing.value.status === "completed") {
          return parseStoredJson(existing.value.resultJson);
        }

        if (existing.value.status === "failed") {
          return yield* runtimeEffectError("execution/service", 
              existing.value.errorText
                ?? `Stored tool step ${String(stepSequence)} failed`,
            );
        }
      } else {
        const now = Date.now();
        yield* input.executorState.executionSteps.insert({
          id: executionStepIdFor(input.executionId, stepSequence),
          executionId: input.executionId,
          sequence: stepSequence,
          kind: "tool_call",
          status: "pending",
          path,
          argsJson,
          resultJson: null,
          errorText: null,
          interactionId: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      try {
        const value = yield* input.toolInvoker.invoke({ path, args, context });
        const updatedAt = Date.now();

        yield* input.executorState.executionSteps.updateByExecutionAndSequence(
          input.executionId,
          stepSequence,
          {
            status: "completed",
            resultJson: serializeJson(value),
            errorText: null,
            updatedAt,
          },
        );

        return value;
      } catch (error) {
        const updatedAt = Date.now();

        if (isExecutionSuspendedValue(error)) {
          yield* input.executorState.executionSteps.updateByExecutionAndSequence(
            input.executionId,
            stepSequence,
            {
              status: "waiting",
              updatedAt,
            },
          );

          return yield* Effect.fail(error);
        }

        yield* input.executorState.executionSteps.updateByExecutionAndSequence(
          input.executionId,
          stepSequence,
          {
            status: "failed",
            errorText: error instanceof Error ? error.message : String(error),
            updatedAt,
          },
        );

        return yield* Effect.fail(error);
      }
    }),
});

const persistExecutionOutcome = (input: {
  executorState: ExecutorStateStoreShape;
  liveExecutionManager: LiveExecutionManager;
  executionId: Execution["id"];
  outcome: {
    result: unknown;
    error?: string;
    logs?: string[];
  };
}) =>
  Effect.gen(function* () {
    if (isExecutionSuspendedValue(input.outcome.error)) {
      return;
    }

    if (input.outcome.error) {
      const [execution, pendingInteraction] = yield* Effect.all([
        input.executorState.executions.getById(input.executionId),
        input.executorState.executionInteractions.getPendingByExecutionId(input.executionId),
      ]);

      if (
        Option.isSome(execution)
        && execution.value.status === "waiting_for_interaction"
        && Option.isSome(pendingInteraction)
      ) {
        return;
      }
    }

    const completedAt = Date.now();
    const updated = yield* input.executorState.executions.update(input.executionId, {
      status: input.outcome.error ? "failed" : "completed",
      resultJson: serializeJson(input.outcome.result),
      errorText: input.outcome.error ?? null,
      logsJson: serializeJson(input.outcome.logs ?? null),
      completedAt,
      updatedAt: completedAt,
    });

    if (Option.isNone(updated)) {
      yield* input.liveExecutionManager.clearRun(input.executionId);
      return;
    }

    yield* input.liveExecutionManager.finishRun({
      executionId: input.executionId,
      state: updated.value.status === "completed" ? "completed" : "failed",
    });

    yield* input.executorState.executionSteps.deleteByExecutionId(input.executionId);
  });

const persistExecutionFailure = (input: {
  executorState: ExecutorStateStoreShape;
  liveExecutionManager: LiveExecutionManager;
  executionId: Execution["id"];
  error: string;
}) =>
  Effect.gen(function* () {
    const completedAt = Date.now();
    const updated = yield* input.executorState.executions.update(input.executionId, {
      status: "failed",
      errorText: input.error,
      completedAt,
      updatedAt: completedAt,
    });

    if (Option.isNone(updated)) {
      yield* input.liveExecutionManager.clearRun(input.executionId);
      return;
    }

    yield* input.liveExecutionManager.finishRun({
      executionId: input.executionId,
      state: "failed",
    });

    yield* input.executorState.executionSteps.deleteByExecutionId(input.executionId);
  });

const runExecutionAttemptWithDependencies = (
  store: ExecutorStateStoreShape,
  executionResolver: ResolveExecutionEnvironment,
  liveExecutionManager: LiveExecutionManager,
  execution: Execution,
  interactionMode: InteractionMode,
) =>
  executionResolver({
    scopeId: execution.scopeId,
    actorScopeId: execution.createdByScopeId,
    executionId: execution.id,
    onElicitation: createHybridOnElicitation({
      executorState: store,
      executionId: execution.id,
      liveExecutionManager,
      interactionMode,
    }),
  }).pipe(
    Effect.map((environment) => ({
      executor: environment.executor,
      toolInvoker: withExecutionInvocationContext({
        executionId: execution.id,
        toolInvoker: createReplayToolInvoker({
          executorState: store,
          executionId: execution.id,
          toolInvoker: environment.toolInvoker,
        }),
      }),
    })),
    Effect.flatMap(({ executor, toolInvoker }) =>
      executor.execute(execution.code, toolInvoker)
    ),
    Effect.flatMap((outcome) =>
      persistExecutionOutcome({
        executorState: store,
        liveExecutionManager,
        executionId: execution.id,
        outcome,
      })
    ),
    Effect.catchAll((error) =>
      persistExecutionFailure({
        executorState: store,
        liveExecutionManager,
        executionId: execution.id,
        error: error instanceof Error ? error.message : String(error),
      }).pipe(
        Effect.catchAll(() => liveExecutionManager.clearRun(execution.id)),
      )
    ),
  );

const forkExecutionAttemptWithDependencies = (
  store: ExecutorStateStoreShape,
  executionResolver: ResolveExecutionEnvironment,
  liveExecutionManager: LiveExecutionManager,
  execution: Execution,
  interactionMode: InteractionMode,
) =>
  Effect.gen(function* () {
    const runtimeLocalScope = yield* getRuntimeLocalScopeOption();

    yield* Effect.sync(() => {
      const effect = runExecutionAttemptWithDependencies(
        store,
        executionResolver,
        liveExecutionManager,
        execution,
        interactionMode,
      );

      Effect.runFork(
        provideOptionalRuntimeLocalScope(effect, runtimeLocalScope),
      );
    });
  });

const submitExecutionInteractionResponseWithDependencies = (
  store: ExecutorStateStoreShape,
  executionResolver: ResolveExecutionEnvironment,
  liveExecutionManager: LiveExecutionManager,
  input: {
    executionId: ExecutionId;
    response: ElicitationResponse;
    interactionMode: InteractionMode;
  },
) =>
  Effect.gen(function* () {
    const execution = yield* store.executions.getById(input.executionId);
    if (Option.isNone(execution)) {
      return false;
    }

    const pendingInteraction = yield* store.executionInteractions.getPendingByExecutionId(
      input.executionId,
    );
    if (Option.isNone(pendingInteraction)) {
      return false;
    }

    if (
      execution.value.status !== "waiting_for_interaction"
      && execution.value.status !== "failed"
    ) {
      return false;
    }

    const now = Date.now();
    const steps = yield* store.executionSteps.listByExecutionId(input.executionId);
    const waitingStep = [...steps]
      .reverse()
      .find((step) => step.interactionId === pendingInteraction.value.id);

    if (waitingStep) {
      yield* store.executionSteps.updateByExecutionAndSequence(
        input.executionId,
        waitingStep.sequence,
        {
          status: "waiting",
          errorText: null,
          updatedAt: now,
        },
      );
    }

    yield* store.executionInteractions.update(pendingInteraction.value.id, {
      status: input.response.action === "cancel" ? "cancelled" : "resolved",
      responseJson: serializeJson(
        sanitizePersistedElicitationResponse(input.response),
      ),
      responsePrivateJson: serializeJson(input.response),
      updatedAt: now,
    });

    const updated = yield* store.executions.update(input.executionId, {
      status: "running",
      updatedAt: now,
    });
    if (Option.isNone(updated)) {
      return false;
    }

    yield* forkExecutionAttemptWithDependencies(
      store,
      executionResolver,
      liveExecutionManager,
      updated.value,
      input.interactionMode,
    );

    return true;
  });

const createExecutionWithDependencies = (
  store: ExecutorStateStoreShape,
  executionResolver: ResolveExecutionEnvironment,
  liveExecutionManager: LiveExecutionManager,
  input: {
    scopeId: ScopeId;
    payload: CreateExecutionPayload;
    createdByScopeId: ScopeId;
  },
) =>
  Effect.gen(function* () {
    const code = input.payload.code;
    const now = Date.now();
    const execution: Execution = {
      id: ExecutionIdSchema.make(`exec_${crypto.randomUUID()}`),
      scopeId: input.scopeId,
      createdByScopeId: input.createdByScopeId,
      status: "pending",
      code,
      resultJson: null,
      errorText: null,
      logsJson: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    yield* executionOps.create.child("insert").mapStorage(
      store.executions.insert(execution),
    );

    const running = yield* executionOps.create.child("mark_running").mapStorage(
      store.executions.update(execution.id, {
        status: "running",
        startedAt: now,
        updatedAt: now,
      }),
    );

    if (Option.isNone(running)) {
      return yield* executionOps.create.notFound(
          "Execution not found after insert",
          `executionId=${execution.id}`,
        );
    }

    const nextState = yield* liveExecutionManager.registerStateWaiter(execution.id);

    yield* forkExecutionAttemptWithDependencies(
      store,
      executionResolver,
      liveExecutionManager,
      running.value,
      resolveInteractionMode(input.payload.interactionMode),
    );

    yield* Deferred.await(nextState);

    return yield* fetchExecutionEnvelope(store, {
      scopeId: input.scopeId,
      executionId: execution.id,
      operation: executionOps.create,
    });
  });

export const createExecution = (input: {
  scopeId: ScopeId;
  payload: CreateExecutionPayload;
  createdByScopeId: ScopeId;
}) =>
  Effect.gen(function* () {
    const store = yield* ExecutorStateStore;
    const executionResolver = yield* RuntimeExecutionResolverService;
    const liveExecutionManager = yield* LiveExecutionManagerService;

    return yield* createExecutionWithDependencies(
      store,
      executionResolver,
      liveExecutionManager,
      input,
    );
  });

export const getExecution = (input: {
  scopeId: ScopeId;
  executionId: ExecutionId;
}) =>
  Effect.flatMap(ExecutorStateStore, (store) =>
    fetchExecutionEnvelope(store, {
      scopeId: input.scopeId,
      executionId: input.executionId,
      operation: executionOps.get,
    })
  );

export const listExecutions = (input: {
  scopeId: ScopeId;
}) =>
  Effect.flatMap(ExecutorStateStore, (store) =>
    executionOps.list.mapStorage(store.executions.listByScope(input.scopeId))
  );

export const submitExecutionInteractionResponse = (input: {
  executionId: ExecutionId;
  response: ElicitationResponse;
  interactionMode?: InteractionMode;
}) =>
  Effect.gen(function* () {
    const store = yield* ExecutorStateStore;
    const executionResolver = yield* RuntimeExecutionResolverService;
    const liveExecutionManager = yield* LiveExecutionManagerService;

    return yield* submitExecutionInteractionResponseWithDependencies(
      store,
      executionResolver,
        liveExecutionManager,
        {
          ...input,
          interactionMode: input.interactionMode ?? DEFAULT_INTERACTION_MODE,
        },
      );
  });

export const resumeExecution = (input: {
  scopeId: ScopeId;
  executionId: ExecutionId;
  payload: ResumeExecutionPayload;
  resumedByScopeId: ScopeId;
}) =>
  Effect.gen(function* () {
    const store = yield* ExecutorStateStore;
    const executionResolver = yield* RuntimeExecutionResolverService;
    const liveExecutionManager = yield* LiveExecutionManagerService;

    const existing = yield* fetchExecutionEnvelope(store, {
      scopeId: input.scopeId,
      executionId: input.executionId,
      operation: "executions.resume",
    });

    if (
      existing.execution.status !== "waiting_for_interaction"
      && !(
        existing.execution.status === "failed"
        && existing.pendingInteraction !== null
      )
    ) {
      return yield* executionOps.resume.badRequest(
          "Execution is not waiting for interaction",
          `executionId=${input.executionId} status=${existing.execution.status}`,
        );
    }

    const responseJson = input.payload.responseJson;
    const response =
      responseJson === undefined
        ? { action: "accept" as const }
        : yield* Effect.try({
            try: () => JSON.parse(responseJson),
            catch: (error) =>
              executionOps.resume.badRequest(
                "Invalid responseJson",
                error instanceof Error ? error.message : String(error),
              ),
          }).pipe(
            Effect.flatMap((decoded) =>
              decodeElicitationResponse(decoded).pipe(
                Effect.mapError((error) =>
                  executionOps.resume.badRequest(
                    "Invalid responseJson",
                    String(error),
                  ),
                ),
              )
            ),
          );

    const resumedLive = yield* liveExecutionManager.resolveInteraction({
      executionId: input.executionId,
      response,
    });

    if (!resumedLive) {
      const resumed = yield* executionOps.resume.child("submit_interaction").mapStorage(
        submitExecutionInteractionResponseWithDependencies(
          store,
          executionResolver,
          liveExecutionManager,
          {
            executionId: input.executionId,
            response,
            interactionMode: resolveInteractionMode(input.payload.interactionMode),
          },
        ),
      );

      if (!resumed) {
        return yield* executionOps.resume.badRequest(
            "Resume is unavailable for this execution",
            `executionId=${input.executionId}`,
          );
      }
    }

    return yield* waitForExecutionEnvelopeToSettle(store, {
      scopeId: input.scopeId,
      executionId: input.executionId,
      operation: executionOps.resume,
      previousPendingInteractionId: existing.pendingInteraction?.id ?? null,
      attemptsRemaining: 400,
    });
  });
