import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  CodeExecutor,
  ExecuteResult,
  ToolInvoker,
} from "@executor/codemode-core";
import * as Effect from "effect/Effect";

export type SesExecutorOptions = {
  timeoutMs?: number;
  allowFetch?: boolean;
};

export type InProcessExecutorOptions = SesExecutorOptions;

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_EVALUATION_ID = "evaluation";
const WORKER_PATH = fileURLToPath(new URL("./sandbox-worker.mjs", import.meta.url));

type ReadyMessage = {
  type: "ready";
};

type ToolCallMessage = {
  type: "tool-call";
  callId: string;
  path: string;
  args: unknown;
};

type ResultMessage = {
  type: "result";
  id: string;
  value?: unknown;
  error?: string;
  logs?: string[];
};

type WorkerMessage = ReadyMessage | ToolCallMessage | ResultMessage;

type EvaluateMessage = {
  type: "evaluate";
  id: string;
  code: string;
  allowFetch: boolean;
};

type ToolResponseMessage = {
  type: "tool-response";
  callId: string;
  value?: unknown;
  error?: string;
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const createSandboxWorker = (): ChildProcess => fork(WORKER_PATH, [], { silent: true });

const describeWorkerExit = (
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error => {
  const stderrSuffix = stderr.trim().length > 0 ? `\n${stderr.trim()}` : "";

  if (signal) {
    return new Error(`SES worker exited from signal ${signal}${stderrSuffix}`);
  }

  if (typeof code === "number") {
    return new Error(`SES worker exited with code ${code}${stderrSuffix}`);
  }

  return new Error(`SES worker exited before returning a result${stderrSuffix}`);
};

const sendMessage = (child: ChildProcess, message: EvaluateMessage | ToolResponseMessage): void => {
  if (typeof child.send !== "function") {
    throw new Error("SES worker IPC channel is unavailable");
  }

  child.send(message);
};

const evaluateInSandbox = async (
  options: SesExecutorOptions,
  code: string,
  toolInvoker: ToolInvoker,
): Promise<ExecuteResult> => {
  const child = createSandboxWorker();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stderrChunks: string[] = [];

  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk.toString());
    });
  }

  return new Promise<ExecuteResult>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }

      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);

      if (!child.killed) {
        child.kill();
      }
    };

    const settle = (effect: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      effect();
    };

    const resetTimeout = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      timeoutHandle = setTimeout(() => {
        settle(() => {
          reject(new Error(`Execution timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);
    };

    const onError = (error: Error) => {
      settle(() => {
        reject(error);
      });
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settle(() => {
        reject(describeWorkerExit(code, signal, stderrChunks.join("")));
      });
    };

    const onMessage = (message: WorkerMessage) => {
      if (message.type === "ready") {
        resetTimeout();
        sendMessage(child, {
          type: "evaluate",
          id: DEFAULT_EVALUATION_ID,
          code,
          allowFetch: options.allowFetch === true,
        });
        return;
      }

      if (message.type === "tool-call") {
        resetTimeout();

        void Effect.runPromise(toolInvoker.invoke({ path: message.path, args: message.args }))
          .then((value) => {
            if (settled) {
              return;
            }

            resetTimeout();
            sendMessage(child, {
              type: "tool-response",
              callId: message.callId,
              value,
            });
          })
          .catch((cause) => {
            if (settled) {
              return;
            }

            resetTimeout();
            const error = toError(cause);
            sendMessage(child, {
              type: "tool-response",
              callId: message.callId,
              error: error.stack ?? error.message,
            });
          });
        return;
      }

      if (message.type === "result") {
        settle(() => {
          if (message.error) {
            resolve({
              result: null,
              error: message.error,
              logs: message.logs ?? [],
            });
            return;
          }

          resolve({
            result: message.value,
            logs: message.logs ?? [],
          });
        });
      }
    };

    child.on("error", onError);
    child.on("exit", onExit);
    child.on("message", onMessage);

    resetTimeout();
  });
};

const runInSes = (
  options: SesExecutorOptions,
  code: string,
  toolInvoker: ToolInvoker,
): Effect.Effect<ExecuteResult, Error> =>
  Effect.tryPromise({
    try: () => evaluateInSandbox(options, code, toolInvoker),
    catch: toError,
  });

export const makeSesExecutor = (
  options: SesExecutorOptions = {},
): CodeExecutor => ({
  execute: (code: string, toolInvoker: ToolInvoker) => runInSes(options, code, toolInvoker),
});

export const makeInProcessExecutor = makeSesExecutor;
