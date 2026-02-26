import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Source } from "@executor-v2/schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import {
  ToolProviderRegistryError,
  ToolProviderRegistryService,
  type CanonicalToolDescriptor,
  type ToolProviderError,
} from "./tool-providers";
import { spawnDenoWorkerProcess } from "./deno-worker-process";

export class DenoSubprocessRunnerError extends Data.TaggedError(
  "DenoSubprocessRunnerError",
)<{
  operation: string;
  message: string;
  details: string | null;
}> {}

export type DenoRunnableTool = {
  descriptor: CanonicalToolDescriptor;
  source: Source | null;
};

export type ExecuteJavaScriptInDenoInput = {
  code: string;
  tools: ReadonlyArray<DenoRunnableTool>;
  timeoutMs?: number;
  denoExecutable?: string;
};

const IPC_PREFIX = "@@engine-ipc@@";

const HostStartMessageSchema = Schema.Struct({
  type: Schema.Literal("start"),
  code: Schema.String,
  toolIds: Schema.Array(Schema.String),
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
  toolId: Schema.String,
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

const duplicateToolIdError = (toolId: string): DenoSubprocessRunnerError =>
  new DenoSubprocessRunnerError({
    operation: "build_tools",
    message: `Duplicate tool id in run context: ${toolId}`,
    details: null,
  });

const missingToolBindingError = (toolId: string): DenoSubprocessRunnerError =>
  new DenoSubprocessRunnerError({
    operation: "invoke_tool",
    message: `Worker requested unknown tool id: ${toolId}`,
    details: null,
  });

const toolCallFailedError = (toolId: string): DenoSubprocessRunnerError =>
  new DenoSubprocessRunnerError({
    operation: "invoke_tool",
    message: `Tool call returned error: ${toolId}`,
    details: null,
  });

const parseWorkerMessageError = (
  line: string,
  cause: unknown,
): DenoSubprocessRunnerError =>
  new DenoSubprocessRunnerError({
    operation: "decode_worker_message",
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
    message,
    details,
  });

const buildToolBindings = (
  tools: ReadonlyArray<DenoRunnableTool>,
): Effect.Effect<Map<string, DenoRunnableTool>, DenoSubprocessRunnerError> =>
  Effect.gen(function* () {
    const byToolId = new Map<string, DenoRunnableTool>();

    for (const tool of tools) {
      const toolId = tool.descriptor.toolId;
      if (byToolId.has(toolId)) {
        return yield* duplicateToolIdError(toolId);
      }
      byToolId.set(toolId, tool);
    }

    return byToolId;
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

const workerScriptPath = fileURLToPath(
  new URL("./deno-subprocess-worker.mjs", import.meta.url),
);

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

const handleToolCall = (
  message: WorkerToolCallMessage,
  toolBindings: ReadonlyMap<string, DenoRunnableTool>,
  runPromise: <A, E>(
    effect: Effect.Effect<A, E, never>,
  ) => Promise<A>,
  invokeTool: (
    input: {
      source: Source | null;
      tool: CanonicalToolDescriptor;
      args: unknown;
    },
  ) => Effect.Effect<
    { output: unknown; isError: boolean },
    ToolProviderRegistryError | ToolProviderError
  >,
  stdin: NodeJS.WritableStream,
): Effect.Effect<void, DenoSubprocessRunnerError> =>
  Effect.gen(function* () {
    const binding = toolBindings.get(message.toolId);
    if (!binding) {
      return yield* writeMessage(stdin, {
        type: "tool_result",
        requestId: message.requestId,
        ok: false,
        error: missingToolBindingError(message.toolId).message,
      });
    }

    const invokeResult = yield* Effect.tryPromise({
      try: () =>
        runPromise(
          invokeTool({
            source: binding.source,
            tool: binding.descriptor,
            args: message.args,
          }),
        ),
      catch: (cause) =>
        workerProcessError(
          "invoke_tool",
          "Tool invocation threw while handling worker tool_call",
          String(cause),
        ),
    });

    if (invokeResult.isError) {
      yield* writeMessage(stdin, {
        type: "tool_result",
        requestId: message.requestId,
        ok: false,
        error: toolCallFailedError(message.toolId).message,
      });
      return;
    }

    yield* writeMessage(stdin, {
      type: "tool_result",
      requestId: message.requestId,
      ok: true,
      value: invokeResult.output,
    });
  });

export const isDenoSubprocessRuntimeAvailable = (
  executable: string = defaultDenoExecutable(),
): boolean => executable.includes("/") ? existsSync(executable) : true;

export const executeJavaScriptInDenoSubprocess = (
  input: ExecuteJavaScriptInDenoInput,
): Effect.Effect<
  unknown,
  DenoSubprocessRunnerError | ToolProviderRegistryError | ToolProviderError,
  ToolProviderRegistryService
> =>
  Effect.gen(function* () {
    const registry = yield* ToolProviderRegistryService;
    const runtime = yield* Effect.runtime<never>();
    const runPromise = Runtime.runPromise(runtime);
    const toolBindings = yield* buildToolBindings(input.tools);
    const toolIds = Array.from(toolBindings.keys()).sort();
    const denoExecutable = input.denoExecutable ?? defaultDenoExecutable();
    const timeoutMs = Math.max(100, input.timeoutMs ?? 30_000);
    return yield* Effect.tryPromise({
      try: () =>
        new Promise<unknown>((resolve, reject) => {
          let settled = false;
          let stderrBuffer = "";
          let worker: ReturnType<typeof spawnDenoWorkerProcess> | null = null;
          const finish = (result: { ok: true; value: unknown } | { ok: false; error: Error }) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeout);
            worker?.dispose();
            if (result.ok) {
              resolve(result.value);
            } else {
              reject(result.error);
            }
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
                    "invoke_tool",
                    "Deno subprocess unavailable while handling worker tool_call",
                    null,
                  ),
                );
                return;
              }

              runPromise(
                handleToolCall(
                  message,
                  toolBindings,
                  runPromise,
                  (invokeInput) => registry.invoke(invokeInput),
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
                scriptPath: workerScriptPath,
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
              toolIds,
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
