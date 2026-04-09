/**
 * DynamicWorkerExecutor — runs sandboxed code in an isolated Cloudflare
 * Worker via the WorkerLoader binding.
 *
 * Tool calls are dispatched over Workers RPC:  the host creates a
 * `ToolDispatcher` (an `RpcTarget`) that bridges back to the
 * `SandboxToolInvoker` from codemode-core, and passes it to the dynamic
 * worker's `evaluate()` entrypoint.
 */

import { RpcTarget } from "cloudflare:workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type {
  CodeExecutor,
  ExecuteResult,
  SandboxToolInvoker,
} from "@executor/codemode-core";

import { normalizeCode } from "./normalize";
import { buildExecutorModule } from "./module-template";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DynamicWorkerExecutionError extends Data.TaggedError(
  "DynamicWorkerExecutionError",
)<{
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const ENTRY_MODULE = "executor.js";

// ---------------------------------------------------------------------------
// ToolDispatcher — bridges RPC calls back to SandboxToolInvoker
// ---------------------------------------------------------------------------

/**
 * An `RpcTarget` passed to the dynamic Worker so that sandboxed code can
 * invoke tools on the host.  The dynamic worker calls
 * `__dispatcher.call(path, argsJson)` over Workers RPC.
 */
export class ToolDispatcher extends RpcTarget {
  readonly #invoker: SandboxToolInvoker;

  constructor(invoker: SandboxToolInvoker) {
    super();
    this.#invoker = invoker;
  }

  async call(path: string, argsJson: string): Promise<string> {
    const args = argsJson ? JSON.parse(argsJson) : undefined;

    return Effect.runPromise(
      this.#invoker.invoke({ path, args }).pipe(
        Effect.map((value) =>
          JSON.stringify({ result: value }),
        ),
        Effect.catchAll((cause) =>
          Effect.succeed(
            JSON.stringify({
              error:
                cause instanceof Error
                  ? cause.message
                  : typeof cause === "object" &&
                      cause !== null &&
                      "message" in cause
                    ? String((cause as { message: unknown }).message)
                    : String(cause),
            }),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

const evaluate = async (
  options: DynamicWorkerExecutorOptions,
  code: string,
  toolInvoker: SandboxToolInvoker,
): Promise<ExecuteResult> => {
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const normalized = normalizeCode(code);
  const executorModule = buildExecutorModule(normalized, timeoutMs);

  const { [ENTRY_MODULE]: _, ...safeModules } = options.modules ?? {};

  const dispatcher = new ToolDispatcher(toolInvoker);

  const worker = options.loader.get(
    `executor-${crypto.randomUUID()}`,
    () => ({
      compatibilityDate: "2025-06-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: ENTRY_MODULE,
      modules: {
        ...safeModules,
        [ENTRY_MODULE]: executorModule,
      },
      globalOutbound: options.globalOutbound ?? null,
    }),
  );

  const entrypoint = worker.getEntrypoint() as unknown as {
    evaluate(dispatcher: ToolDispatcher): Promise<{
      result: unknown;
      error?: string;
      logs?: string[];
    }>;
  };

  const response = await entrypoint.evaluate(dispatcher);

  return {
    result: response.error ? null : response.result,
    error: response.error,
    logs: response.logs,
  };
};

// ---------------------------------------------------------------------------
// Effect wrapper
// ---------------------------------------------------------------------------

const runInDynamicWorker = (
  options: DynamicWorkerExecutorOptions,
  code: string,
  toolInvoker: SandboxToolInvoker,
): Effect.Effect<ExecuteResult, DynamicWorkerExecutionError> =>
  Effect.tryPromise({
    try: () => evaluate(options, code, toolInvoker),
    catch: (cause) =>
      new DynamicWorkerExecutionError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const makeDynamicWorkerExecutor = (
  options: DynamicWorkerExecutorOptions,
): CodeExecutor => ({
  execute: (code: string, toolInvoker: SandboxToolInvoker) =>
    runInDynamicWorker(options, code, toolInvoker),
});
