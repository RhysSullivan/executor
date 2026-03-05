import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import {
  RuntimeAdapterError,
  type RuntimeAdapter,
  type RuntimeToolCallService,
} from "@executor-v2/engine";
import { spawnDenoWorkerProcess } from "./deno-worker-process";

const runtimeKind = "deno-subprocess";

export const DenoSubprocessRunnerError = RuntimeAdapterError;
export type DenoSubprocessRunnerError = RuntimeAdapterError;

export type ExecuteJavaScriptInDenoInput = {
  runId: string;
  code: string;
  toolCallService?: RuntimeToolCallService;
  timeoutMs?: number;
  denoExecutable?: string;
};

type DenoSubprocessRuntimeAdapterOptions = {
  denoExecutable?: string;
  defaultTimeoutMs?: number;
};

const IPC_PREFIX = "@@engine-ipc@@";

const HostStartMessageSchema = Schema.Struct({
  type: Schema.Literal("start"),
  code: Schema.String,
});

const HostToolResultMessageSchema = Schema.Struct({
  type: Schema.Literal("tool_result"),
  requestId: Schema.String,
  ok: Schema.Boolean,
  value: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});

const HostToWorkerMessageSchema = Schema.Union(
  HostStartMessageSchema,
  HostToolResultMessageSchema,
);

const WorkerToolCallMessageSchema = Schema.Struct({
  type: Schema.Literal("tool_call"),
  requestId: Schema.String,
  toolPath: Schema.String,
  args: Schema.Unknown,
});

const WorkerCompletedMessageSchema = Schema.Struct({
  type: Schema.Literal("completed"),
  result: Schema.Unknown,
});

const WorkerFailedMessageSchema = Schema.Struct({
  type: Schema.Literal("failed"),
  error: Schema.String,
});

const WorkerToHostMessageSchema = Schema.Union(
  WorkerToolCallMessageSchema,
  WorkerCompletedMessageSchema,
  WorkerFailedMessageSchema,
);

type HostToWorkerMessage = typeof HostToWorkerMessageSchema.Type;
type WorkerToHostMessage = typeof WorkerToHostMessageSchema.Type;
type WorkerToolCallMessage = typeof WorkerToolCallMessageSchema.Type;

const decodeWorkerMessageLine = Schema.decodeUnknownSync(
  Schema.parseJson(WorkerToHostMessageSchema),
);
const encodeHostMessage = Schema.encodeSync(Schema.parseJson(HostToWorkerMessageSchema));

const missingToolCallServiceError = (toolPath: string): DenoSubprocessRunnerError =>
  new DenoSubprocessRunnerError({
    operation: "call_tool",
    runtimeKind,
    message: `No tool call service configured for path: ${toolPath}`,
    details: null,
  });

const parseWorkerMessageError = (
  line: string,
  cause: unknown,
): DenoSubprocessRunnerError =>
  new DenoSubprocessRunnerError({
    operation: "decode_worker_message",
    runtimeKind,
    message: "Failed to decode worker message",
    details: `${line}\n${String(cause)}`,
  });

const workerProcessError = (
  operation: string,
  message: string,
  details: string | null,
): DenoSubprocessRunnerError =>
  new DenoSubprocessRunnerError({
    operation,
    runtimeKind,
    message,
    details,
  });

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

const resolveWorkerScriptPath = (): string => {
  const moduleUrl = String(import.meta.url);

  if (moduleUrl.startsWith("/")) {
    return moduleUrl;
  }

  try {
    const workerUrl = new URL("./deno-subprocess-worker.mjs", moduleUrl);
    if (workerUrl.protocol === "file:") {
      return fileURLToPath(workerUrl);
    }

    return workerUrl.pathname.length > 0 ? workerUrl.pathname : workerUrl.toString();
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

const writeMessage = (
  stdin: NodeJS.WritableStream,
  message: HostToWorkerMessage,
): Effect.Effect<void, DenoSubprocessRunnerError> =>
  Effect.try({
    try: () => {
      stdin.write(`${encodeHostMessage(message)}\n`);
    },
    catch: (cause) =>
      workerProcessError(
        "write_message",
        "Failed to write message to Deno subprocess",
        String(cause),
      ),
  });

const normalizeToolInput = (args: unknown): Record<string, unknown> | undefined => {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }

  return args as Record<string, unknown>;
};

const callTool = (
  runId: string,
  message: WorkerToolCallMessage,
  toolCallService: RuntimeToolCallService | undefined,
): Effect.Effect<unknown, DenoSubprocessRunnerError> =>
  Effect.gen(function* () {
    if (!toolCallService) {
      return yield* missingToolCallServiceError(message.toolPath);
    }

    return yield* toolCallService
      .callTool({
        runId,
        callId: message.requestId,
        toolPath: message.toolPath,
        input: normalizeToolInput(message.args),
      })
      .pipe(
        Effect.mapError((cause) =>
          workerProcessError(
            "call_tool",
            `Tool call failed: ${message.toolPath}`,
            cause.details ?? cause.message,
          ),
        ),
      );
  });

const handleToolCall = (
  runId: string,
  message: WorkerToolCallMessage,
  toolCallService: RuntimeToolCallService | undefined,
  runPromise: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>,
  stdin: NodeJS.WritableStream,
): Effect.Effect<void, DenoSubprocessRunnerError> =>
  Effect.gen(function* () {
    const invokeResult = yield* Effect.tryPromise({
      try: () => runPromise(Effect.either(callTool(runId, message, toolCallService))),
      catch: (cause) =>
        workerProcessError(
          "call_tool",
          "Tool invocation threw while handling worker tool_call",
          String(cause),
        ),
    });

    if (invokeResult._tag === "Left") {
      yield* writeMessage(stdin, {
        type: "tool_result",
        requestId: message.requestId,
        ok: false,
        error: invokeResult.left.message,
      });
      return;
    }

    yield* writeMessage(stdin, {
      type: "tool_result",
      requestId: message.requestId,
      ok: true,
      value: invokeResult.right,
    });
  });

export const isDenoSubprocessRuntimeAvailable = (
  executable: string = defaultDenoExecutable(),
): boolean => (executable.includes("/") ? existsSync(executable) : true);

export const executeJavaScriptInDenoSubprocess = (
  input: ExecuteJavaScriptInDenoInput,
): Effect.Effect<unknown, DenoSubprocessRunnerError> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const runPromise = Runtime.runPromise(runtime);
    const denoExecutable = input.denoExecutable ?? defaultDenoExecutable();
    const timeoutMs = Math.max(100, input.timeoutMs ?? 30_000);

    return yield* Effect.tryPromise({
      try: () =>
        new Promise<unknown>((resolve, reject) => {
          let settled = false;
          let stderrBuffer = "";
          let worker: ReturnType<typeof spawnDenoWorkerProcess> | null = null;

          const finish = (
            result: { ok: true; value: unknown } | { ok: false; error: Error },
          ) => {
            if (settled) {
              return;
            }

            settled = true;
            clearTimeout(timeout);
            worker?.dispose();

            if (result.ok) {
              resolve(result.value);
              return;
            }

            reject(result.error);
          };

          const fail = (error: DenoSubprocessRunnerError) => {
            finish({ ok: false, error });
          };

          const timeout = setTimeout(() => {
            fail(
              workerProcessError(
                "timeout",
                `Deno subprocess execution timed out after ${timeoutMs}ms`,
                stderrBuffer.length > 0 ? stderrBuffer : null,
              ),
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
              message = decodeWorkerMessageLine(payload);
            } catch (cause) {
              fail(parseWorkerMessageError(payload, cause));
              return;
            }

            if (message.type === "tool_call") {
              if (!worker) {
                fail(
                  workerProcessError(
                    "call_tool",
                    "Deno subprocess unavailable while handling worker tool_call",
                    null,
                  ),
                );
                return;
              }

              runPromise(
                handleToolCall(
                  input.runId,
                  message,
                  input.toolCallService,
                  runPromise,
                  worker.stdin,
                ),
              ).catch((cause) => {
                fail(
                  cause instanceof DenoSubprocessRunnerError
                    ? cause
                    : workerProcessError(
                        "handle_tool_call",
                        "Failed handling worker tool_call",
                        String(cause),
                      ),
                );
              });
              return;
            }

            if (message.type === "completed") {
              finish({ ok: true, value: message.result });
              return;
            }

            fail(
              workerProcessError(
                "worker_failed",
                "Deno subprocess returned failed terminal message",
                message.error,
              ),
            );
          };

          try {
            worker = spawnDenoWorkerProcess(
              {
                executable: denoExecutable,
                scriptPath: workerScriptPath(),
              },
              {
                onStdoutLine: handleStdoutLine,
                onStderr: (chunk) => {
                  stderrBuffer += chunk;
                },
                onError: (cause) => {
                  fail(
                    workerProcessError(
                      "spawn",
                      "Failed to spawn Deno subprocess",
                      cause.message,
                    ),
                  );
                },
                onExit: (code, signal) => {
                  if (settled) {
                    return;
                  }

                  fail(
                    workerProcessError(
                      "process_exit",
                      "Deno subprocess exited before returning terminal message",
                      `code=${String(code)} signal=${String(signal)} stderr=${stderrBuffer}`,
                    ),
                  );
                },
              },
            );
          } catch (cause) {
            fail(
              workerProcessError(
                "spawn",
                "Failed to spawn Deno subprocess",
                cause instanceof Error ? cause.message : String(cause),
              ),
            );
            return;
          }

          runPromise(
            writeMessage(worker.stdin, {
              type: "start",
              code: input.code,
            }),
          ).catch((cause) => {
            fail(
              cause instanceof DenoSubprocessRunnerError
                ? cause
                : workerProcessError(
                    "start_message",
                    "Failed sending start message to Deno subprocess",
                    String(cause),
                  ),
            );
          });
        }),
      catch: (cause) =>
        cause instanceof DenoSubprocessRunnerError
          ? cause
          : workerProcessError(
              "execute",
              "Unexpected Deno subprocess execution failure",
              String(cause),
            ),
    });
  });

export const makeDenoSubprocessRuntimeAdapter = (
  options: DenoSubprocessRuntimeAdapterOptions = {},
): RuntimeAdapter => ({
  kind: "deno-subprocess",
  isAvailable: () => Effect.succeed(true),
  execute: (input) =>
    executeJavaScriptInDenoSubprocess({
      runId: input.runId,
      code: input.code,
      toolCallService: input.toolCallService,
      timeoutMs: input.timeoutMs ?? options.defaultTimeoutMs,
      denoExecutable: options.denoExecutable,
    }),
});
