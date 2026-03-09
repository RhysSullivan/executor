import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  CodeExecutor,
  ExecuteResult,
  ToolInvoker,
} from "@executor/codemode-core";
import * as Effect from "effect/Effect";

import {
  type DenoPermissions,
  spawnDenoWorkerProcess,
} from "./deno-worker-process";

export type { DenoPermissions };

export type DenoSubprocessExecutorOptions = {
  /** Path to the deno binary. Falls back to DENO_BIN env, ~/.deno/bin/deno, then "deno". */
  denoExecutable?: string;
  /** Maximum execution time in milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Deno permission flags. Defaults to denying everything (full sandbox). */
  permissions?: DenoPermissions;
};

const IPC_PREFIX = "@@executor-ipc@@";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// --------------------------------------------------------------------------
// IPC message types (host <-> worker)
// --------------------------------------------------------------------------

type HostStartMessage = {
  type: "start";
  code: string;
};

type HostToolResultMessage = {
  type: "tool_result";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

type HostToWorkerMessage = HostStartMessage | HostToolResultMessage;

type WorkerToolCallMessage = {
  type: "tool_call";
  requestId: string;
  toolPath: string;
  args: unknown;
};

type WorkerCompletedMessage = {
  type: "completed";
  result: unknown;
  logs?: string[];
};

type WorkerFailedMessage = {
  type: "failed";
  error: string;
  logs?: string[];
};

type WorkerToHostMessage =
  | WorkerToolCallMessage
  | WorkerCompletedMessage
  | WorkerFailedMessage;

// --------------------------------------------------------------------------
// Deno binary resolution
// --------------------------------------------------------------------------

const defaultDenoExecutable = (): string => {
  const configured = process.env.DENO_BIN?.trim();
  if (configured) {
    return configured;
  }

  const home = process.env.HOME?.trim();
  if (home) {
    const installedPath = `${home}/.deno/bin/deno`;
    if (existsSync(installedPath)) {
      return installedPath;
    }
  }

  return "deno";
};

const formatDenoSpawnError = (
  cause: unknown,
  executable: string,
): string => {
  const code = typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : null;

  if (code === "ENOENT") {
    return `Failed to spawn Deno subprocess: Deno executable "${executable}" was not found. Install Deno or set DENO_BIN.`;
  }

  return `Failed to spawn Deno subprocess: ${cause instanceof Error ? cause.message : String(cause)}`;
};

// --------------------------------------------------------------------------
// Worker script resolution
// --------------------------------------------------------------------------

const resolveWorkerScriptPath = (): string => {
  const moduleUrl = String(import.meta.url);

  if (moduleUrl.startsWith("/")) {
    return moduleUrl;
  }

  try {
    const workerUrl = new URL(
      "./deno-subprocess-worker.mjs",
      moduleUrl,
    );
    if (workerUrl.protocol === "file:") {
      return fileURLToPath(workerUrl);
    }

    return workerUrl.pathname.length > 0
      ? workerUrl.pathname
      : workerUrl.toString();
  } catch {
    return moduleUrl;
  }
};

let cachedWorkerScriptPath: string | undefined;

const workerScriptPath = (): string => {
  if (!cachedWorkerScriptPath) {
    cachedWorkerScriptPath = resolveWorkerScriptPath();
  }

  return cachedWorkerScriptPath;
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const writeMessage = (
  stdin: NodeJS.WritableStream,
  message: HostToWorkerMessage,
): void => {
  stdin.write(`${JSON.stringify(message)}\n`);
};

const isWorkerMessage = (value: unknown): value is WorkerToHostMessage =>
  typeof value === "object"
  && value !== null
  && "type" in value
  && typeof (value as Record<string, unknown>).type === "string";

// --------------------------------------------------------------------------
// Core execution
// --------------------------------------------------------------------------

const executeInDeno = (
  code: string,
  toolInvoker: ToolInvoker,
  options: DenoSubprocessExecutorOptions,
): Effect.Effect<ExecuteResult, never> =>
  Effect.gen(function* () {
    const denoExecutable =
      options.denoExecutable ?? defaultDenoExecutable();
    const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const result = yield* Effect.async<ExecuteResult>((resume) => {
      let settled = false;
      let stderrBuffer = "";
      let worker: ReturnType<typeof spawnDenoWorkerProcess> | null =
        null;

      const finish = (executeResult: ExecuteResult) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        worker?.dispose();
        resume(Effect.succeed(executeResult));
      };

      const fail = (
        error: string,
        logs?: string[],
      ) => {
        finish({
          result: null,
          error,
          logs,
        });
      };

      const timeout = setTimeout(() => {
        fail(
          `Deno subprocess execution timed out after ${timeoutMs}ms`,
        );
      }, timeoutMs);

      const handleStdoutLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (line.length === 0 || !line.startsWith(IPC_PREFIX)) {
          return;
        }

        const payload = line.slice(IPC_PREFIX.length);
        let message: WorkerToHostMessage;
        try {
          const parsed: unknown = JSON.parse(payload);
          if (!isWorkerMessage(parsed)) {
            fail(`Invalid worker message: ${payload}`);
            return;
          }
          message = parsed;
        } catch (cause) {
          fail(
            `Failed to decode worker message: ${payload}\n${String(cause)}`,
          );
          return;
        }

        if (message.type === "tool_call") {
          if (!worker) {
            fail(
              "Deno subprocess unavailable while handling worker tool_call",
            );
            return;
          }

          const currentWorker = worker;

          Effect.runPromise(
            Effect.match(
              Effect.tryPromise({
                try: () =>
                  Effect.runPromise(
                    toolInvoker.invoke({
                      path: message.toolPath,
                      args: message.args,
                    }),
                  ),
                catch: (cause) =>
                  cause instanceof Error
                    ? cause
                    : new Error(String(cause)),
              }),
              {
                onSuccess: (value) => {
                  writeMessage(currentWorker.stdin, {
                    type: "tool_result",
                    requestId: message.requestId,
                    ok: true,
                    value,
                  });
                },
                onFailure: (error) => {
                  writeMessage(currentWorker.stdin, {
                    type: "tool_result",
                    requestId: message.requestId,
                    ok: false,
                    error: error.message,
                  });
                },
              },
            ),
          ).catch((cause) => {
            fail(
              `Failed handling worker tool_call: ${String(cause)}`,
            );
          });

          return;
        }

        if (message.type === "completed") {
          finish({
            result: message.result,
            logs: message.logs,
          });
          return;
        }

        // message.type === "failed"
        fail(message.error, message.logs);
      };

      try {
        worker = spawnDenoWorkerProcess(
          {
            executable: denoExecutable,
            scriptPath: workerScriptPath(),
            permissions: options.permissions,
          },
          {
            onStdoutLine: handleStdoutLine,
            onStderr: (chunk) => {
              stderrBuffer += chunk;
            },
            onError: (cause) => {
              fail(formatDenoSpawnError(cause, denoExecutable));
            },
            onExit: (exitCode, signal) => {
              if (settled) {
                return;
              }

              fail(
                `Deno subprocess exited before returning terminal message (code=${String(exitCode)} signal=${String(signal)} stderr=${stderrBuffer})`,
              );
            },
          },
        );
      } catch (cause) {
        fail(formatDenoSpawnError(cause, denoExecutable));
        return;
      }

      writeMessage(worker.stdin, {
        type: "start",
        code,
      });
    });

    return result;
  });

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Check whether the configured (or default) Deno binary is available on the system.
 */
export const isDenoAvailable = (
  executable: string = defaultDenoExecutable(),
): boolean => {
  const result = spawnSync(executable, ["--version"], {
    stdio: "ignore",
    timeout: 5000,
  });

  return result.error === undefined && result.status === 0;
};

/**
 * Create a `CodeExecutor` that runs code in a sandboxed Deno subprocess.
 *
 * The subprocess is spawned with `--deny-net --deny-read --deny-write --deny-env --deny-run --deny-ffi`
 * by default, providing strong process-level isolation. Tool calls are proxied back to the host
 * via stdin/stdout IPC and resolved through the provided `ToolInvoker`.
 */
export const makeDenoSubprocessExecutor = (
  options: DenoSubprocessExecutorOptions = {},
): CodeExecutor => ({
  execute: (code: string, toolInvoker: ToolInvoker) =>
    executeInDeno(code, toolInvoker, options),
});
