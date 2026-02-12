"use node";

// NOTE: The Vercel sandbox runtime (vercel-sandbox-runtime.ts) contains a JS
// string version of similar logic, built from sandbox-fragments.ts. Changes to
// the core helpers here (createToolsProxy, console proxy, execution
// loop, result mapping) should be mirrored there.
import { APPROVAL_DENIED_PREFIX, TASK_TIMEOUT_MARKER } from "../execution-constants";
import { Result } from "better-result";
import { Script, createContext } from "node:vm";
import type {
  ExecutionAdapter,
  SandboxExecutionRequest,
  SandboxExecutionResult,
} from "../types";
import { transpileForRuntime } from "./transpile";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeExecutionResult(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  const serialized = Result.try(() => JSON.stringify(value));
  if (serialized.isErr()) {
    return String(value);
  }

  if (serialized.value === undefined) {
    return null;
  }

  return Result.try(() => JSON.parse(serialized.value) as unknown).unwrapOr(String(value));
}

function createToolsProxy(
  adapter: ExecutionAdapter,
  runId: string,
  path: string[] = [],
): unknown {
  const callable = () => {};
  return new Proxy(callable, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof prop !== "string") return undefined;
      return createToolsProxy(adapter, runId, [...path, prop]);
    },
    async apply(_target, _thisArg, args) {
      const toolPath = path.join(".");
      if (!toolPath) {
        throw new Error("Tool path missing in invocation");
      }

      const input = args.length > 0 ? args[0] : {};
      const callId = `call_${crypto.randomUUID()}`;

      while (true) {
        const result = await adapter.invokeTool({
          runId,
          callId,
          toolPath,
          input,
        });

        if (result.ok) {
          return result.value;
        }

        switch (result.kind) {
          case "pending":
            await sleep(Math.max(50, result.retryAfterMs ?? 500));
            continue;
          case "denied":
            throw new Error(`${APPROVAL_DENIED_PREFIX}${result.error}`);
          case "failed":
          default:
            throw new Error(result.error);
        }
      }
    },
  });
}

/** Classify a caught error from VM execution into a result status. */
function classifyExecutionError(
  error: unknown,
  request: SandboxExecutionRequest,
): { status: SandboxExecutionResult["status"]; message: string } {
  const message = error instanceof Error ? error.message : String(error);

  if (message === TASK_TIMEOUT_MARKER || message.includes("Script execution timed out")) {
    return {
      status: "timed_out",
      message: `Execution timed out after ${request.timeoutMs}ms`,
    };
  }

  if (message.startsWith(APPROVAL_DENIED_PREFIX)) {
    return {
      status: "denied",
      message: message.replace(APPROVAL_DENIED_PREFIX, "").trim(),
    };
  }

  return { status: "failed", message };
}

export async function runCodeWithAdapter(
  request: SandboxExecutionRequest,
  adapter: ExecutionAdapter,
): Promise<SandboxExecutionResult> {
  const startedAt = Date.now();

  const mkResult = (
    status: SandboxExecutionResult["status"],
    opts?: { error?: string; exitCode?: number; result?: unknown },
  ): SandboxExecutionResult => ({
    status,
    result: opts?.result,
    exitCode: opts?.exitCode,
    error: opts?.error,
    durationMs: Date.now() - startedAt,
  });

  // ── Transpile ──────────────────────────────────────────────────────────
  const transpiled = transpileForRuntime(request.code);
  if (transpiled.isErr()) {
    return mkResult("failed", { error: transpiled.error.message });
  }

  // ── Sandbox setup ──────────────────────────────────────────────────────
  const tools = createToolsProxy(adapter, request.taskId);
  const consoleProxy = {
    log: (..._args: unknown[]) => {},
    info: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {},
  };

  const sandbox = Object.assign(Object.create(null), {
    tools,
    console: consoleProxy,
    setTimeout,
    clearTimeout,
  });
  const context = createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  const runnerScript = new Script(
    `(async () => {\n"use strict";\n${transpiled.value}\n})()`,
  );

  // ── Execute with timeout ───────────────────────────────────────────────
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(TASK_TIMEOUT_MARKER));
    }, request.timeoutMs);
  });

  const execution = await Result.tryPromise(async () => {
    const value = await Promise.race([
      Promise.resolve(
        runnerScript.runInContext(context, {
          timeout: Math.max(1, request.timeoutMs),
        }),
      ),
      timeoutPromise,
    ]);
    return value;
  });

  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (execution.isErr()) {
    const { status, message } = classifyExecutionError(
      execution.error.cause,
      request,
    );
    return mkResult(status, { error: message });
  }

  return mkResult("completed", {
    exitCode: 0,
    result: sanitizeExecutionResult(execution.value),
  });
}
