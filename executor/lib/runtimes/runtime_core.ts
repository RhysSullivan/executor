"use node";

// NOTE: The Vercel sandbox runtime (vercel-sandbox-runtime.ts) contains a JS
// string version of similar logic, built from sandbox-fragments.ts. Changes to
// the core helpers here (formatArgs, createToolsProxy, console proxy, execution
// loop, result mapping) should be mirrored there.
import { APPROVAL_DENIED_PREFIX, TASK_TIMEOUT_MARKER } from "../execution_constants";
import { Script, createContext } from "node:vm";
import type {
  ExecutionAdapter,
  SandboxExecutionRequest,
  SandboxExecutionResult,
} from "../types";

async function transpileForRuntime(code: string): Promise<string> {
  let ts: typeof import("typescript");
  try {
    ts = require("typescript");
  } catch {
    return code;
  }

  const target = ts.ScriptTarget?.ES2022 ?? ts.ScriptTarget?.ESNext;
  const moduleKind = ts.ModuleKind?.ESNext;

  const result = ts.transpileModule(code, {
    compilerOptions: {
      ...(target !== undefined ? { target } : {}),
      ...(moduleKind !== undefined ? { module: moduleKind } : {}),
    },
    reportDiagnostics: true,
  });

  if (result.diagnostics && result.diagnostics.length > 0) {
    const first = result.diagnostics[0];
    const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    throw new Error(`TypeScript transpile error: ${message}`);
  }

  return result.outputText || code;
}

function formatArgs(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
}

function fireAndForget(promise: void | Promise<void>): void {
  if (promise && typeof promise === "object" && "then" in promise) {
    void (promise as Promise<void>).catch(() => {});
  }
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
      const result = await adapter.invokeTool({
        runId,
        callId: `call_${crypto.randomUUID()}`,
        toolPath,
        input,
      });

      if (result.ok) {
        return result.value;
      }

      if (result.denied) {
        throw new Error(`${APPROVAL_DENIED_PREFIX}${result.error}`);
      }

      throw new Error(result.error);
    },
  });
}

export async function runCodeWithAdapter(
  request: SandboxExecutionRequest,
  adapter: ExecutionAdapter,
): Promise<SandboxExecutionResult> {
  const startedAt = Date.now();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const appendStdout = (line: string): void => {
    stdoutLines.push(line);
    fireAndForget(
      adapter.emitOutput({
        runId: request.taskId,
        stream: "stdout",
        line,
        timestamp: Date.now(),
      }),
    );
  };

  const appendStderr = (line: string): void => {
    stderrLines.push(line);
    fireAndForget(
      adapter.emitOutput({
        runId: request.taskId,
        stream: "stderr",
        line,
        timestamp: Date.now(),
      }),
    );
  };

  const tools = createToolsProxy(adapter, request.taskId);
  const consoleProxy = {
    log: (...args: unknown[]) => appendStdout(formatArgs(args)),
    info: (...args: unknown[]) => appendStdout(formatArgs(args)),
    warn: (...args: unknown[]) => appendStderr(formatArgs(args)),
    error: (...args: unknown[]) => appendStderr(formatArgs(args)),
  };

  const sandbox = Object.assign(Object.create(null), {
    tools,
    console: consoleProxy,
    setTimeout,
    clearTimeout,
  });
  const context = createContext(sandbox, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
  });

  const executableCode = await transpileForRuntime(request.code);
  const runnerScript = new Script(`(async () => {\n"use strict";\n${executableCode}\n})()`);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(TASK_TIMEOUT_MARKER));
    }, request.timeoutMs);
  });

  try {
    const value = await Promise.race([
      Promise.resolve(runnerScript.runInContext(context, { timeout: Math.max(1, request.timeoutMs) })),
      timeoutPromise,
    ]);

    if (value !== undefined) {
      appendStdout(`result: ${formatArgs([value])}`);
    }

    return {
      status: "completed",
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
      exitCode: 0,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === TASK_TIMEOUT_MARKER || message.includes("Script execution timed out")) {
      const timeoutMessage = `Execution timed out after ${request.timeoutMs}ms`;
      appendStderr(timeoutMessage);
      return {
        status: "timed_out",
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
        error: timeoutMessage,
        durationMs: Date.now() - startedAt,
      };
    }

    if (message.startsWith(APPROVAL_DENIED_PREFIX)) {
      const deniedMessage = message.replace(APPROVAL_DENIED_PREFIX, "").trim();
      appendStderr(deniedMessage);
      return {
        status: "denied",
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
        error: deniedMessage,
        durationMs: Date.now() - startedAt,
      };
    }

    appendStderr(message);
    return {
      status: "failed",
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
      error: message,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
