// ---------------------------------------------------------------------------
// @executor/execution/promise — Promise-native surface for the execution
// engine.
// ---------------------------------------------------------------------------
//
// `engine.ts` is Effect-native; this module runs each method with
// `Effect.runPromise` at the boundary so hosts that can't compose Effects
// (the MCP SDK tool handlers, plain async call sites) can still use the
// engine. Callers already inside an Effect context should import directly
// from `@executor/execution` to keep trace context intact.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type * as Cause from "effect/Cause";

import type {
  ElicitationContext,
  ElicitationResponse,
  Executor as PromiseExecutor,
} from "@executor/sdk";
import type { CodeExecutionError, CodeExecutor, ExecuteResult } from "@executor/codemode-core";

import {
  createExecutionEngine as createEffectExecutionEngine,
  type ExecutionEngine as EffectExecutionEngine,
  type ExecutionResult,
  type PausedExecution,
  type ResumeResponse,
} from "./engine";

export type ElicitationHandler = (
  ctx: ElicitationContext,
) => Promise<ElicitationResponse>;

export type ExecutionEngineConfig<
  E extends Cause.YieldableError = CodeExecutionError,
> = {
  readonly executor: PromiseExecutor;
  readonly codeExecutor: CodeExecutor<E>;
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
 * `tools.{invoke,list,schema,definitions}` and `sources.list`.
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

/**
 * Promise-wrap an Effect-native `ExecutionEngine` (from `./engine`).
 * Exposed separately so callers that already hold an Effect engine
 * (apps/cloud's execution-stack composes both) can convert it for hosts
 * that need the Promise surface (host-mcp).
 */
export const toPromiseExecutionEngine = <E extends Cause.YieldableError>(
  engine: EffectExecutionEngine<E>,
): ExecutionEngine => ({
  execute: (code, options) =>
    Effect.runPromise(
      engine.execute(code, {
        onElicitation: (ctx) =>
          Effect.tryPromise(() => options.onElicitation(ctx)).pipe(Effect.orDie),
      }),
    ),
  executeWithPause: (code) => Effect.runPromise(engine.executeWithPause(code)),
  resume: (executionId, response) => Effect.runPromise(engine.resume(executionId, response)),
  getDescription: () => Effect.runPromise(engine.getDescription),
});

export const createExecutionEngine = <
  E extends Cause.YieldableError = CodeExecutionError,
>(
  config: ExecutionEngineConfig<E>,
): ExecutionEngine =>
  toPromiseExecutionEngine(
    createEffectExecutionEngine({
      executor: wrapPromiseExecutor(config.executor),
      codeExecutor: config.codeExecutor,
    }),
  );

// ---------------------------------------------------------------------------
// Re-exports — plain types/helpers that don't carry Effect signatures.
// ---------------------------------------------------------------------------

export { formatExecuteResult, formatPausedExecution } from "./engine";

export type { ExecutionResult, PausedExecution, ResumeResponse };

export { buildExecuteDescription } from "./description";
export { ExecutionToolError } from "./errors";
