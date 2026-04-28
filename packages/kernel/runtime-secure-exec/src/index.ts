import {
  recoverExecutionBody,
  type CodeExecutor,
  type ExecuteResult,
  type SandboxToolInvoker,
} from "@executor/codemode-core";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import { allowAll, createInMemoryFileSystem, createKernel, createNodeRuntime } from "secure-exec";

export type SecureExecExecutorOptions = {
  timeoutMs?: number;
  memoryLimitMb?: number;
};

const formatUnknownMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    const message = cause.message.trim();
    return message.length > 0 ? message : cause.name;
  }

  if (typeof cause === "string") {
    return cause;
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    const message = cause.message.trim();
    if (message.length > 0) return message;
  }

  if (typeof cause === "object" && cause !== null) {
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }

  return String(cause);
};

const formatCauseMessage = (cause: Cause.Cause<unknown>): string =>
  formatUnknownMessage(Cause.squash(cause));

class SecureExecExecutionError extends Data.TaggedError("SecureExecExecutionError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `${this.operation}: ${formatUnknownMessage(this.cause)}`;
  }
}

class SecureExecTimeoutError extends Data.TaggedError("SecureExecTimeoutError")<{
  readonly timeoutMs: number;
}> {}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MEMORY_LIMIT_MB = 128;
const TEXT_ENCODER = new TextEncoder();

const serializeJson = (value: unknown): string | undefined => {
  if (typeof value === "undefined") return undefined;
  try {
    return JSON.stringify(value);
  } catch (cause) {
    throw new Error(
      `Value is not JSON serializable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

const IPC_RESULT_PREFIX = "@@executor-result@@";

const timeoutMessage = (timeoutMs: number): string =>
  `Secure-exec execution timed out after ${timeoutMs}ms`;

type ToolSuccessEnvelope = {
  readonly ok: true;
  readonly value?: string;
};

type ToolErrorEnvelope = {
  readonly ok: false;
  readonly error: string;
};

type ToolEnvelope = ToolSuccessEnvelope | ToolErrorEnvelope;

type RuntimePromiseRunner = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;

type SecureExecKernel = ReturnType<typeof createKernel>;

type KernelProcess = {
  readonly exitCode: number | null;
  wait(): Promise<number>;
  kill(signal?: number): void;
};

type ProcessOutcome =
  | {
      readonly _tag: "Exited";
      readonly exitCode: number;
    }
  | {
      readonly _tag: "TimedOut";
    };

type ProcessOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly outcome: ProcessOutcome;
};

const wrapSync = <A>(operation: string, fn: () => A): Effect.Effect<A, SecureExecExecutionError> =>
  Effect.try({
    try: fn,
    catch: (cause) => new SecureExecExecutionError({ operation, cause }),
  }).pipe(Effect.withSpan(`secure_exec.${operation}`));

const wrap = <A>(
  operation: string,
  fn: () => Promise<A>,
): Effect.Effect<A, SecureExecExecutionError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new SecureExecExecutionError({ operation, cause }),
  }).pipe(Effect.withSpan(`secure_exec.${operation}`));

const use = <T, A>(
  operation: string,
  client: T,
  fn: (client: T) => Promise<A>,
): Effect.Effect<A, SecureExecExecutionError> => wrap(operation, () => fn(client));

const useSync = <T, A>(
  operation: string,
  client: T,
  fn: (client: T) => A,
): Effect.Effect<A, SecureExecExecutionError> => wrapSync(operation, () => fn(client));

const encodeToolEnvelope = (envelope: ToolEnvelope): string => {
  try {
    return JSON.stringify(envelope);
  } catch (cause) {
    return JSON.stringify({
      ok: false,
      error: `Tool envelope serialization failed: ${formatUnknownMessage(cause)}`,
    } satisfies ToolErrorEnvelope);
  }
};

const parseToolArgs = (argsJson: unknown): Effect.Effect<unknown, SecureExecExecutionError> =>
  typeof argsJson === "string"
    ? wrapSync("tool.parse_args", () => JSON.parse(argsJson))
    : Effect.void;

const invokeToolBinding = (
  toolInvoker: SandboxToolInvoker,
  path: unknown,
  argsJson: unknown,
): Effect.Effect<string, never> =>
  Effect.gen(function* () {
    const toolPath = String(path);
    const args = yield* parseToolArgs(argsJson);

    const envelope = yield* toolInvoker.invoke({ path: toolPath, args }).pipe(
      Effect.flatMap((value) =>
        wrapSync("tool.serialize_result", () => ({
          ok: true as const,
          value: serializeJson(value),
        })),
      ),
      Effect.catchAllCause((cause) =>
        Effect.succeed<ToolErrorEnvelope>({
          ok: false,
          error: formatCauseMessage(cause),
        }),
      ),
    );

    return encodeToolEnvelope(envelope);
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.succeed(
        encodeToolEnvelope({
          ok: false,
          error: formatCauseMessage(cause),
        }),
      ),
    ),
  );

const buildExecutionSource = (code: string): string => {
  const body = recoverExecutionBody(code);

  // Tool invocation uses async bindings via SecureExec.bindings.__invokeTool.
  // Console methods use SecureExec.bindings.__log for structured log capture.
  return `
"use strict";

const __invokeTool = SecureExec.bindings.invokeTool;
const __log = SecureExec.bindings.emitLog;

const __formatLogArg = (value) => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};
const __formatLogLine = (args) => args.map(__formatLogArg).join(' ');

const __makeToolsProxy = (path = []) => new Proxy(() => undefined, {
  get(_target, prop) {
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    return __makeToolsProxy([...path, String(prop)]);
  },
  apply(_target, _thisArg, args) {
    const toolPath = path.join('.');
    if (!toolPath) throw new Error('Tool path missing in invocation');
    const argsJson = args[0] !== undefined ? JSON.stringify(args[0]) : undefined;
    return Promise.resolve(__invokeTool(toolPath, argsJson))
      .then((raw) => {
        const envelope = JSON.parse(raw);
        if (!envelope.ok) throw new Error(envelope.error || 'Tool invocation failed');
        return envelope.value === undefined ? undefined : JSON.parse(envelope.value);
      });
  },
});
const tools = __makeToolsProxy();

const console = {
  log: (...args) => __log('log', __formatLogLine(args)),
  warn: (...args) => __log('warn', __formatLogLine(args)),
  error: (...args) => __log('error', __formatLogLine(args)),
  info: (...args) => __log('info', __formatLogLine(args)),
  debug: (...args) => __log('debug', __formatLogLine(args)),
};

try {
  const v = await (async () => {
    ${body}
  })();
  if (v !== undefined) process.stdout.write(${JSON.stringify(IPC_RESULT_PREFIX)} + JSON.stringify(v) + '\\n');
} catch (e) {
  const msg = e && typeof e === 'object' ? (e.stack || e.message || String(e)) : String(e);
  process.stderr.write(msg + '\\n');
  process.exitCode = 1;
}
`.trim();
};

const acquireScopedKernel = (
  source: string,
  memoryLimitMb: number,
  toolInvoker: SandboxToolInvoker,
  logs: string[],
  runPromise: RuntimePromiseRunner,
) =>
  Effect.gen(function* () {
    const vfs = createInMemoryFileSystem();
    yield* use("vfs.write_entry", vfs, (fs) =>
      fs.writeFile("/entry.mjs", TEXT_ENCODER.encode(source)),
    );

    const kernel = createKernel({
      filesystem: vfs,
      permissions: allowAll,
    });

    yield* Effect.addFinalizer(() =>
      use("kernel.dispose", kernel, (k) => k.dispose()).pipe(Effect.orDie),
    );

    yield* use("kernel.mount_runtime", kernel, (k) =>
      k.mount(
        createNodeRuntime({
          memoryLimit: memoryLimitMb,
          permissions: allowAll,
          bindings: {
            invokeTool: (path: unknown, argsJson: unknown) =>
              runPromise(invokeToolBinding(toolInvoker, path, argsJson)),
            emitLog: (level: unknown, line: unknown) => {
              logs.push(`[${String(level)}] ${String(line)}`);
            },
          },
        }),
      ),
    );

    return kernel;
  });

const waitForProcess = (
  proc: KernelProcess,
  timeoutMs: number,
): Effect.Effect<ProcessOutcome, SecureExecExecutionError> =>
  use("process.wait", proc, (p) => p.wait()).pipe(
    Effect.map(
      (exitCode): ProcessOutcome => ({
        _tag: "Exited",
        exitCode,
      }),
    ),
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () => new SecureExecTimeoutError({ timeoutMs }),
    }),
    Effect.catchTag("SecureExecTimeoutError", () =>
      useSync("process.kill_on_timeout", proc, (p) => {
        p.kill(9);
        return { _tag: "TimedOut" as const };
      }),
    ),
  );

const runEntryProcess = (
  kernel: SecureExecKernel,
  timeoutMs: number,
): Effect.Effect<ProcessOutput, SecureExecExecutionError> =>
  Effect.gen(function* () {
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();

    const proc = yield* useSync("process.spawn", kernel, (k) =>
      k.spawn("node", ["/entry.mjs"], {
        onStdout: (data: Uint8Array) => {
          stdout += stdoutDecoder.decode(data, { stream: true });
        },
        onStderr: (data: Uint8Array) => {
          stderr += stderrDecoder.decode(data, { stream: true });
        },
      }),
    );

    const outcome = yield* waitForProcess(proc, timeoutMs).pipe(
      Effect.ensuring(
        useSync("process.ensure_killed", proc, (p) => {
          if (p.exitCode === null) {
            p.kill(9);
          }
        }).pipe(Effect.orDie),
      ),
    );

    stdout += stdoutDecoder.decode();
    stderr += stderrDecoder.decode();

    return {
      stdout,
      stderr,
      outcome,
    };
  });

const parseResultFromStdout = (stdout: string): unknown => {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(IPC_RESULT_PREFIX)) continue;
    const payload = line.slice(IPC_RESULT_PREFIX.length);
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return null;
};

const evaluateInSecureExec = (
  options: SecureExecExecutorOptions,
  code: string,
  toolInvoker: SandboxToolInvoker,
): Effect.Effect<ExecuteResult, never> => {
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const memoryLimitMb = options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  const logs: string[] = [];

  return Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const runPromise: RuntimePromiseRunner = Runtime.runPromise(runtime);
    const source = buildExecutionSource(code);

    const processOutput = yield* Effect.scoped(
      Effect.gen(function* () {
        const kernel = yield* acquireScopedKernel(
          source,
          memoryLimitMb,
          toolInvoker,
          logs,
          runPromise,
        );
        return yield* runEntryProcess(kernel, timeoutMs);
      }),
    );

    if (processOutput.outcome._tag === "TimedOut") {
      return {
        result: null,
        error: timeoutMessage(timeoutMs),
        logs,
      } satisfies ExecuteResult;
    }

    if (processOutput.outcome.exitCode !== 0) {
      const errorOutput = processOutput.stderr.trim() || processOutput.stdout.trim();

      return {
        result: null,
        error: errorOutput || `Process exited with code ${processOutput.outcome.exitCode}`,
        logs,
      } satisfies ExecuteResult;
    }

    return {
      result: parseResultFromStdout(processOutput.stdout),
      logs,
    } satisfies ExecuteResult;
  }).pipe(
    Effect.catchTag("SecureExecExecutionError", (error) =>
      Effect.succeed<ExecuteResult>({
        result: null,
        error: error.message,
        logs,
      }),
    ),
    Effect.catchAllCause((cause) =>
      Effect.succeed<ExecuteResult>({
        result: null,
        error: formatCauseMessage(cause),
        logs,
      }),
    ),
  );
};

export const makeSecureExecExecutor = (
  options: SecureExecExecutorOptions = {},
): CodeExecutor<never> => ({
  execute: (code: string, toolInvoker: SandboxToolInvoker) =>
    evaluateInSecureExec(options, code, toolInvoker),
});
