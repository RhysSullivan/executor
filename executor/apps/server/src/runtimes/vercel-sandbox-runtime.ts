import { Sandbox } from "@vercel/sandbox";
import type {
  ExecutionAdapter,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxRuntime,
} from "../types";

const RESULT_MARKER = "__EXECUTOR_RESULT__";

interface VercelSandboxRuntimeOptions {
  controlPlaneBaseUrl: string;
  internalToken?: string;
  runtime?: "node24" | "node22";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function buildRunnerScript(codeFilePath: string): string {
  return `
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const RESULT_MARKER = ${JSON.stringify(RESULT_MARKER)};
const runId = process.env.EXECUTOR_RUN_ID;
const baseUrl = process.env.EXECUTOR_INTERNAL_BASE_URL;
const token = process.env.EXECUTOR_INTERNAL_TOKEN || "";
const requestTimeoutMs = Number(process.env.EXECUTOR_REQUEST_TIMEOUT_MS || "15000");

if (!runId) {
  throw new Error("Missing EXECUTOR_RUN_ID");
}

if (!baseUrl) {
  throw new Error("Missing EXECUTOR_INTERNAL_BASE_URL");
}

const userCode = await readFile(${JSON.stringify(codeFilePath)}, "utf8");
const startedAt = Date.now();
const stdoutLines = [];
const stderrLines = [];

function formatArgs(args) {
  return args.map((value) => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(" ");
}

async function callInternal(path, payload) {
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data = {};
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    const message = typeof data.error === "string"
      ? data.error
      : "Internal request failed (" + response.status + ")";
    throw new Error(message);
  }

  return data;
}

function emitOutput(stream, line) {
  return callInternal("/internal/runs/" + encodeURIComponent(runId) + "/output", {
    stream,
    line,
    timestamp: Date.now(),
  });
}

function appendStdout(line) {
  stdoutLines.push(line);
  void emitOutput("stdout", line);
}

function appendStderr(line) {
  stderrLines.push(line);
  void emitOutput("stderr", line);
}

function createToolsProxy(path = []) {
  const callable = () => {};
  return new Proxy(callable, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof prop !== "string") return undefined;
      return createToolsProxy([...path, prop]);
    },
    async apply(_target, _thisArg, args) {
      const toolPath = path.join(".");
      if (!toolPath) {
        throw new Error("Tool path missing in invocation");
      }

      const data = await callInternal(
        "/internal/runs/" + encodeURIComponent(runId) + "/tool-call",
        {
          callId: "call_" + randomUUID(),
          toolPath,
          input: args.length > 0 ? args[0] : {},
        },
      );

      if (data.ok) {
        return data.value;
      }

      if (data.denied) {
        throw new Error("APPROVAL_DENIED:" + String(data.error || "Tool call denied"));
      }

      throw new Error(String(data.error || "Tool call failed"));
    },
  });
}

const tools = createToolsProxy();
const consoleProxy = {
  log: (...args) => appendStdout(formatArgs(args)),
  info: (...args) => appendStdout(formatArgs(args)),
  warn: (...args) => appendStderr(formatArgs(args)),
  error: (...args) => appendStderr(formatArgs(args)),
};

const context = vm.createContext({
  tools,
  console: consoleProxy,
  setTimeout,
  clearTimeout,
});
const runnerScript = new vm.Script("(async () => {\\n\"use strict\";\\n" + userCode + "\\n})()");

const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error("TASK_TIMEOUT")), requestTimeoutMs);
});

let result;
try {
  const value = await Promise.race([
    Promise.resolve(runnerScript.runInContext(context, { timeout: Math.max(1, requestTimeoutMs) })),
    timeoutPromise,
  ]);
  if (value !== undefined) {
    appendStdout("result: " + formatArgs([value]));
  }

  result = {
    status: "completed",
    stdout: stdoutLines.join("\\n"),
    stderr: stderrLines.join("\\n"),
    exitCode: 0,
    durationMs: Date.now() - startedAt,
  };
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  if (message === "TASK_TIMEOUT" || message.includes("Script execution timed out")) {
    const timeoutMessage = "Execution timed out after " + requestTimeoutMs + "ms";
    appendStderr(timeoutMessage);
    result = {
      status: "timed_out",
      stdout: stdoutLines.join("\\n"),
      stderr: stderrLines.join("\\n"),
      error: timeoutMessage,
      durationMs: Date.now() - startedAt,
    };
  } else if (message.startsWith("APPROVAL_DENIED:")) {
    const deniedMessage = message.slice("APPROVAL_DENIED:".length).trim();
    appendStderr(deniedMessage);
    result = {
      status: "denied",
      stdout: stdoutLines.join("\\n"),
      stderr: stderrLines.join("\\n"),
      error: deniedMessage,
      durationMs: Date.now() - startedAt,
    };
  } else {
    appendStderr(message);
    result = {
      status: "failed",
      stdout: stdoutLines.join("\\n"),
      stderr: stderrLines.join("\\n"),
      error: message,
      durationMs: Date.now() - startedAt,
    };
  }
}

process.stdout.write(RESULT_MARKER + JSON.stringify(result) + "\\n");
`;
}

function parseResultFromStdout(stdout: string): SandboxExecutionResult | null {
  const lines = stdout.split("\n");
  const resultLine = lines.find((line) => line.startsWith(RESULT_MARKER));
  if (!resultLine) {
    return null;
  }

  try {
    return JSON.parse(resultLine.slice(RESULT_MARKER.length)) as SandboxExecutionResult;
  } catch {
    return null;
  }
}

export class VercelSandboxRuntime implements SandboxRuntime {
  readonly id = "vercel-sandbox";
  readonly label = "Vercel Sandbox Runtime";
  readonly description = "Runs generated JavaScript inside Vercel Sandbox microVMs.";

  constructor(private readonly options: VercelSandboxRuntimeOptions) {}

  async run(
    request: SandboxExecutionRequest,
    _adapter: ExecutionAdapter,
  ): Promise<SandboxExecutionResult> {
    const startedAt = Date.now();
    const baseUrl = stripTrailingSlash(this.options.controlPlaneBaseUrl);
    if (!baseUrl) {
      return {
        status: "failed",
        stdout: "",
        stderr: "",
        error: "Vercel sandbox runtime misconfigured: missing controlPlaneBaseUrl",
        durationMs: Date.now() - startedAt,
      };
    }

    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl)) {
      return {
        status: "failed",
        stdout: "",
        stderr: "",
        error:
          "Vercel sandbox runtime requires a publicly reachable EXECUTOR_INTERNAL_BASE_URL (localhost is not reachable from Vercel).",
        durationMs: Date.now() - startedAt,
      };
    }

    const sandboxTimeoutMs = Math.max(request.timeoutMs + 30_000, 120_000);
    const sandbox = await Sandbox.create({
      runtime: this.options.runtime ?? "node22",
      timeout: sandboxTimeoutMs,
    });

    const codePath = "task-code.js";
    const runnerPath = "executor-runner.mjs";

    try {
      await sandbox.writeFiles([
        { path: codePath, content: Buffer.from(request.code, "utf8") },
        { path: runnerPath, content: Buffer.from(buildRunnerScript(codePath), "utf8") },
      ]);

      const command = await sandbox.runCommand({
        cmd: "node",
        args: [runnerPath],
        env: {
          EXECUTOR_RUN_ID: request.taskId,
          EXECUTOR_INTERNAL_BASE_URL: baseUrl,
          EXECUTOR_INTERNAL_TOKEN: this.options.internalToken ?? "",
          EXECUTOR_REQUEST_TIMEOUT_MS: String(request.timeoutMs),
        },
      });

      const [stdout, stderr] = await Promise.all([
        command.stdout(),
        command.stderr(),
      ]);

      const parsed = parseResultFromStdout(stdout);
      if (parsed) {
        return parsed;
      }

      return {
        status: command.exitCode === 0 ? "completed" : "failed",
        stdout,
        stderr,
        exitCode: command.exitCode,
        error: command.exitCode === 0 ? undefined : `Sandbox command exited with code ${command.exitCode}`,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        status: "failed",
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await sandbox.stop();
    }
  }
}
