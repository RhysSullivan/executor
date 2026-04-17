// ---------------------------------------------------------------------------
// @executor/execution/promise — Promise-native surface for the execution
// engine. Accepts a Promise-style Executor (from @executor/sdk) and an
// async `onElicitation` handler — no Effect imports required by callers.
//
// Under the hood the engine is Effect-based, so we wrap the incoming
// Promise executor into the minimal Effect shape the engine consumes,
// and bridge the elicitation handler via `Effect.tryPromise`.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import type {
  ElicitationContext,
  ElicitationResponse,
  Executor as PromiseExecutor,
} from "@executor/sdk";
import type { CodeExecutor, ExecuteResult } from "@executor/codemode-core";

import {
  createExecutionEngine as createEffectExecutionEngine,
  type ExecutionResult,
  type PausedExecution,
  type ResumeResponse,
} from "./engine";

export type ElicitationHandler = (
  ctx: ElicitationContext,
) => Promise<ElicitationResponse>;

export type ExecutionEngineConfig = {
  readonly executor: PromiseExecutor;
  readonly codeExecutor: CodeExecutor;
};

export type ExecutionEngine = {
  readonly execute: (
    code: string,
    options: { readonly onElicitation: ElicitationHandler },
  ) => Promise<ExecuteResult>;
  readonly executeWithPause: (code: string) => Promise<ExecutionResult>;
  readonly resume: (
    executionId: string,
    response: ResumeResponse,
  ) => Promise<ExecutionResult | null>;
  readonly getDescription: () => Promise<string>;
};

/**
 * Wrap a Promise-style executor into the Effect shape the engine consumes.
 * Only the four method families the engine actually touches need wrapping:
 * `tools.{invoke,list,schema}` and `sources.list`.
 */
const wrapPromiseExecutor = (pe: PromiseExecutor): any => ({
  scope: (pe as any).scope,
  tools: {
    invoke: (id: unknown, args: unknown, options: unknown) =>
      Effect.tryPromise({
        try: () => (pe.tools as any).invoke(id, args, options),
        catch: (cause) => cause,
      }),
    list: (filter?: unknown) =>
      Effect.tryPromise({
        try: () => (pe.tools as any).list(filter),
        catch: (cause) => cause,
      }).pipe(Effect.orDie),
    schema: (id: unknown) =>
      Effect.tryPromise({
        try: () => (pe.tools as any).schema(id),
        catch: (cause) => cause,
      }),
    definitions: () =>
      Effect.tryPromise({
        try: () => (pe.tools as any).definitions(),
        catch: (cause) => cause,
      }).pipe(Effect.orDie),
  },
  sources: {
    list: () =>
      Effect.tryPromise({
        try: () => (pe.sources as any).list(),
        catch: (cause) => cause,
      }).pipe(Effect.orDie),
  },
});

export const createExecutionEngine = (
  config: ExecutionEngineConfig,
): ExecutionEngine => {
  const engine = createEffectExecutionEngine({
    executor: wrapPromiseExecutor(config.executor),
    codeExecutor: config.codeExecutor,
  });
  return {
    execute: (code, options) =>
      engine.execute(code, {
        onElicitation: (ctx) =>
          Effect.tryPromise(() => options.onElicitation(ctx)).pipe(
            Effect.orDie,
          ),
      }),
    executeWithPause: (code) => engine.executeWithPause(code),
    resume: (executionId, response) => engine.resume(executionId, response),
    getDescription: () => engine.getDescription(),
  };
};

// ---------------------------------------------------------------------------
// Re-exports — plain types/helpers that don't carry Effect signatures.
// ---------------------------------------------------------------------------

export {
  formatExecuteResult,
  formatPausedExecution,
} from "./engine";

export type { ExecutionResult, PausedExecution, ResumeResponse };

export { buildExecuteDescription } from "./description";
export { ExecutionToolError } from "./errors";
