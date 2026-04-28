/**
 * DynamicWorkerExecutor — runs sandboxed code in an isolated Cloudflare
 * Worker via the WorkerLoader binding.
 *
 * Tool calls are dispatched over Workers RPC: the host creates a
 * `ToolDispatcher` (an `RpcTarget`) that bridges back to the
 * `SandboxToolInvoker` from codemode-core, and passes it to the
 * dynamic worker's `evaluate()` entrypoint.
 */

import { RpcTarget } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";

import {
  recoverExecutionBody,
  type CodeExecutor,
  type ExecuteResult,
  type SandboxToolInvoker,
} from "@executor/codemode-core";

import { buildExecutorModule } from "./module-template";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DynamicWorkerExecutionError extends Data.TaggedError("DynamicWorkerExecutionError")<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type DynamicWorkerExecutorOptions = {
  readonly loader: WorkerLoader;
  /**
   * Timeout in milliseconds for code execution. Defaults to 5 minutes.
   */
  readonly timeoutMs?: number;
  /**
   * Controls outbound network access from sandboxed code.
   * - `null` (default): `fetch()` and `connect()` throw — fully isolated.
   * - `undefined`: inherits parent Worker's network access.
   * - A `Fetcher`: all outbound requests route through this handler.
   */
  readonly globalOutbound?: Fetcher | null;
  /**
   * Additional modules to make available in the sandbox.
   * Keys are module specifiers, values are module source code.
   * The key `"executor.js"` is reserved.
   */
  readonly modules?: Record<string, string>;
};

export type SerializedWorkerErrorValue = unknown;

export type SerializedWorkerError = {
  readonly kind: "fail" | "die" | "interrupt" | "mixed" | "unknown";
  readonly message: string;
  readonly primary: SerializedWorkerErrorValue | null;
  readonly failures: ReadonlyArray<SerializedWorkerErrorValue>;
  readonly defects: ReadonlyArray<SerializedWorkerErrorValue>;
  readonly interrupted: boolean;
};

type WorkerRpcSuccess = {
  readonly ok: true;
  readonly result: unknown;
};

type WorkerRpcFailure = {
  readonly ok: false;
  readonly error: SerializedWorkerError;
};

type WorkerRpcResponse = WorkerRpcSuccess | WorkerRpcFailure;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const ENTRY_MODULE = "executor.js";

const normalizeErrorObject = (error: Error) => ({
  __type: "Error" as const,
  name: error.name,
  message: error.message,
  ...(typeof error.stack === "string" && error.stack.length > 0 ? { stack: error.stack } : {}),
});

const isNormalizedErrorObject = (
  value: unknown,
): value is { readonly __type: "Error"; readonly message: string } =>
  typeof value === "object" &&
  value !== null &&
  "__type" in value &&
  value.__type === "Error" &&
  "message" in value &&
  typeof value.message === "string";

const serializeWorkerErrorValue = (value: unknown): SerializedWorkerErrorValue => {
  if (value instanceof Error) {
    return normalizeErrorObject(value);
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as SerializedWorkerErrorValue;
  } catch {
    return String(value);
  }
};

const renderTransportMessage = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (isNormalizedErrorObject(value)) {
    return value.message;
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "object" && value !== null && "message" in value && typeof value.message === "string") {
    return value.message;
  }

  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  if (typeof value === "undefined") {
    return "Unknown error";
  }

  return String(value);
};

export const serializeWorkerCause = (cause: Cause.Cause<unknown>): SerializedWorkerError => {
  const failures = Array.from(Cause.failures(cause), serializeWorkerErrorValue);
  const defects = Array.from(Cause.defects(cause), serializeWorkerErrorValue);
  const interrupted = Cause.isInterrupted(cause);
  const primary = failures[0] ?? defects[0] ?? null;
  const kind =
    failures.length > 0 && defects.length > 0
      ? "mixed"
      : failures.length > 0
        ? "fail"
        : defects.length > 0
          ? "die"
          : interrupted
            ? "interrupt"
            : "unknown";

  return {
    kind,
    message:
      primary !== null
        ? renderTransportMessage(primary)
        : interrupted
          ? "Interrupted"
          : "Unknown error",
    primary,
    failures,
    defects,
    interrupted,
  };
};

export const renderWorkerError = (error: SerializedWorkerError): string => {
  if (isNormalizedErrorObject(error.primary)) {
    return error.primary.message;
  }

  if (typeof error.primary === "string") {
    return error.primary;
  }

  if (typeof error.primary === "object" && error.primary !== null) {
    try {
      return JSON.stringify(error.primary);
    } catch {
      return error.message;
    }
  }

  return error.message;
};

const encodeWorkerRpcResponse = (response: WorkerRpcResponse): string => JSON.stringify(response);

export const decodeWorkerRpcResponse = (raw: string): WorkerRpcResponse =>
  JSON.parse(raw) as WorkerRpcResponse;

// ---------------------------------------------------------------------------
// ToolDispatcher — bridges RPC calls back to SandboxToolInvoker
// ---------------------------------------------------------------------------

/**
 * An `RpcTarget` passed to the dynamic Worker so that sandboxed code can
 * invoke tools on the host. The dynamic worker calls
 * `__dispatcher.call(path, argsJson)` over Workers RPC.
 *
 * Each call is wrapped in an `executor.tool.rpc_dispatch` span so the
 * tool-invocation shell (Workers RPC roundtrip → local invoker →
 * serialize result) is visible in the trace. Tool-level attributes
 * like `mcp.tool.name` already come from the inner
 * `mcp.tool.dispatch` span that `tool-invoker.ts` wraps around
 * `executor.tools.invoke`.
 */
export type RunPromise = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

export class ToolDispatcher extends RpcTarget {
  readonly #invoker: SandboxToolInvoker;
  readonly #runPromise: RunPromise;

  constructor(invoker: SandboxToolInvoker, runPromise: RunPromise) {
    super();
    this.#invoker = invoker;
    this.#runPromise = runPromise;
  }

  async call(path: string, argsJson: string): Promise<string> {
    const args = argsJson ? JSON.parse(argsJson) : undefined;

    return this.#runPromise(
      this.#invoker.invoke({ path, args }).pipe(
        Effect.map(
          (value): WorkerRpcResponse => ({
            ok: true,
            result: value,
          }),
        ),
        Effect.sandbox,
        Effect.catchAll((cause) =>
          Effect.succeed<WorkerRpcResponse>({
            ok: false,
            error: serializeWorkerCause(cause),
          }),
        ),
        Effect.map(encodeWorkerRpcResponse),
        Effect.withSpan("executor.tool.rpc_dispatch", {
          attributes: {
            "mcp.tool.name": path,
            "executor.tool.args_length": argsJson.length,
          },
        }),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

type DynamicWorkerEntrypoint = {
  evaluate(dispatcher: ToolDispatcher): Promise<{
    result: unknown;
    error?: SerializedWorkerError;
    logs?: string[];
  }>;
};

/**
 * Assemble the executor module source and ask the `WorkerLoader` for an
 * isolate. Spans the synchronous module-build + RPC-stub acquisition as
 * `executor.runtime.startup` so the trace separates "did we wait on
 * worker boot?" from the actual `evaluate` RPC roundtrip.
 */
const startDynamicWorker = (
  options: DynamicWorkerExecutorOptions,
  code: string,
  timeoutMs: number,
): Effect.Effect<DynamicWorkerEntrypoint> =>
  Effect.sync((): DynamicWorkerEntrypoint => {
    const recoveredBody = recoverExecutionBody(code);
    const executorModule = buildExecutorModule(recoveredBody, timeoutMs);
    const { [ENTRY_MODULE]: _, ...safeModules } = options.modules ?? {};

    const worker = options.loader.get(`executor-${crypto.randomUUID()}`, () => ({
      compatibilityDate: "2025-06-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: ENTRY_MODULE,
      modules: {
        ...safeModules,
        [ENTRY_MODULE]: executorModule,
      },
      globalOutbound: options.globalOutbound ?? null,
    }));

    return worker.getEntrypoint() as unknown as DynamicWorkerEntrypoint;
  }).pipe(
    Effect.withSpan("executor.runtime.startup", {
      attributes: {
        "executor.runtime": "dynamic-worker",
        "executor.code.length": code.length,
        "executor.timeout_ms": timeoutMs,
        "executor.extra_modules": Object.keys(options.modules ?? {}).length,
      },
    }),
  );

const evaluate = (
  options: DynamicWorkerExecutorOptions,
  code: string,
  toolInvoker: SandboxToolInvoker,
): Effect.Effect<ExecuteResult, DynamicWorkerExecutionError> => {
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const dispatcher = new ToolDispatcher(toolInvoker, Runtime.runPromise(runtime));
    const entrypoint = yield* startDynamicWorker(options, code, timeoutMs);
    const response = yield* Effect.tryPromise({
      try: () => entrypoint.evaluate(dispatcher),
      catch: (cause) =>
        new DynamicWorkerExecutionError({
          message: renderTransportMessage(serializeWorkerErrorValue(cause)),
        }),
    }).pipe(
      Effect.withSpan("executor.runtime.evaluate", {
        attributes: { "executor.runtime": "dynamic-worker" },
      }),
    );
    const error = response.error ? renderWorkerError(response.error) : undefined;
    return {
      result: error ? null : response.result,
      error,
      logs: response.logs,
    } satisfies ExecuteResult;
  });
};

// ---------------------------------------------------------------------------
// Effect wrapper
// ---------------------------------------------------------------------------

const runInDynamicWorker = (
  options: DynamicWorkerExecutorOptions,
  code: string,
  toolInvoker: SandboxToolInvoker,
): Effect.Effect<ExecuteResult, DynamicWorkerExecutionError> =>
  evaluate(options, code, toolInvoker).pipe(
    Effect.withSpan("executor.code.exec.dynamic_worker", {
      attributes: { "executor.runtime": "dynamic-worker" },
    }),
  );

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const makeDynamicWorkerExecutor = (
  options: DynamicWorkerExecutorOptions,
): CodeExecutor<DynamicWorkerExecutionError> => ({
  execute: (code: string, toolInvoker: SandboxToolInvoker) =>
    runInDynamicWorker(options, code, toolInvoker),
});
