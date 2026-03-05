import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

import {
  RuntimeAdapterError,
  type RuntimeAdapter,
  type RuntimeToolCallService,
} from "@executor-v2/engine";

const runtimeKind = "local-inproc";
const runCallResultCache = new Map<string, unknown>();

export type ExecuteJavaScriptInput = {
  runId: string;
  code: string;
  toolCallService?: RuntimeToolCallService;
};

const runtimeError = (
  operation: string,
  message: string,
  details: string | null,
): RuntimeAdapterError =>
  new RuntimeAdapterError({
    operation,
    runtimeKind,
    message,
    details,
  });

const missingToolCallServiceError = (toolPath: string): RuntimeAdapterError =>
  runtimeError(
    "call_tool",
    `No tool call service configured for tool path: ${toolPath}`,
    null,
  );

const isRuntimeAdapterErrorLike = (
  cause: unknown,
): cause is {
  operation: string;
  runtimeKind: string;
  details: string | null;
  _tag?: string;
} => {
  if (!cause || typeof cause !== "object") {
    return false;
  }

  const record = cause as Record<string, unknown>;
  return (record._tag === "RuntimeAdapterError" || record.name === "RuntimeAdapterError")
    && typeof record.operation === "string"
    && typeof record.runtimeKind === "string"
    && (typeof record.details === "string" || record.details === null || record.details === undefined);
};

const toExecutionError = (cause: unknown): RuntimeAdapterError =>
  cause instanceof RuntimeAdapterError
    ? cause
    : isRuntimeAdapterErrorLike(cause)
      ? new RuntimeAdapterError({
        operation: cause.operation,
        runtimeKind: cause.runtimeKind,
        message: cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "Runtime adapter error",
        details: cause.details ?? null,
      })
    : runtimeError(
        "execute",
        "JavaScript execution failed",
        cause instanceof Error ? cause.stack ?? cause.message : String(cause),
      );

const normalizeToolInput = (args: unknown): Record<string, unknown> | undefined => {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }

  return args as Record<string, unknown>;
};

const invokeTool = (
  runId: string,
  callId: string,
  toolPath: string,
  args: unknown,
  toolCallService: RuntimeToolCallService | undefined,
): Effect.Effect<unknown, RuntimeAdapterError> =>
  Effect.gen(function* () {
    if (!toolCallService) {
      return yield* missingToolCallServiceError(toolPath);
    }

    const cacheKey = `${runId}:${callId}`;
    if (runCallResultCache.has(cacheKey)) {
      return runCallResultCache.get(cacheKey);
    }

    const result = yield* toolCallService.callTool({
      runId,
      callId,
      toolPath,
      input: normalizeToolInput(args),
    });

    runCallResultCache.set(cacheKey, result);
    return result;
  });

const nextDeterministicCallId = (counter: { value: number }): string => {
  const callId = `call_${String(counter.value).padStart(6, "0")}`;
  counter.value += 1;
  return callId;
};

const runPromiseWithTypedError = (
  runtime: Runtime.Runtime<never>,
): (<A, E>(effect: Effect.Effect<A, E>) => Promise<A>) =>
  async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const exit = await Runtime.runPromiseExit(runtime)(effect);
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }

    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      throw failure.value;
    }

    throw new Error(Cause.pretty(exit.cause));
  };

const createToolsProxy = (
  runId: string,
  runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  toolCallService: RuntimeToolCallService | undefined,
  callCounter: { value: number },
  path: ReadonlyArray<string> = [],
): unknown => {
  const callable = () => undefined;

  return new Proxy(callable, {
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }

      if (typeof prop !== "string") {
        return undefined;
      }

      return createToolsProxy(runId, runPromise, toolCallService, callCounter, [...path, prop]);
    },
    apply(_target, _thisArg, args) {
      const toolPath = path.join(".");
      if (!toolPath) {
        throw new Error("Tool path missing in invocation");
      }

      const toolArgs = args.length > 0 ? args[0] : undefined;
      const callId = nextDeterministicCallId(callCounter);
      return runPromise(invokeTool(runId, callId, toolPath, toolArgs, toolCallService));
    },
  });
};

const runJavaScript = (
  code: string,
  tools: unknown,
): Effect.Effect<unknown, RuntimeAdapterError> =>
  Effect.tryPromise({
    try: async () => {
      const execute = new Function(
        "tools",
        `"use strict"; return (async () => {\n${code}\n})();`,
      ) as (tools: unknown) => Promise<unknown>;

      return await execute(tools);
    },
    catch: toExecutionError,
  });

export const executeJavaScriptWithTools = (
  input: ExecuteJavaScriptInput,
): Effect.Effect<unknown, RuntimeAdapterError> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const runPromise = runPromiseWithTypedError(runtime);
    const callCounter = { value: 0 };
    const toolsProxy = createToolsProxy(
      input.runId,
      runPromise,
      input.toolCallService,
      callCounter,
    );

    return yield* runJavaScript(input.code, toolsProxy);
  });

export const makeLocalInProcessRuntimeAdapter = (): RuntimeAdapter => ({
  kind: runtimeKind,
  isAvailable: () => Effect.succeed(true),
  execute: (input) =>
    executeJavaScriptWithTools({
      runId: input.runId,
      code: input.code,
      toolCallService: input.toolCallService,
    }),
});
