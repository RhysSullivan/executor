import { ResponseJson as _ResponseJson } from "./globals.js";
import { run } from "./user-code.js";

const APPROVAL_DENIED_PREFIX = "APPROVAL_DENIED:";

function formatArgs(args) {
  return args
    .map((v) => {
      if (typeof v === "string") return v;
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    })
    .join(" ");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createToolsProxy(bridge, path = []) {
  const callable = () => {};
  return new Proxy(callable, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof prop !== "string") return undefined;
      return createToolsProxy(bridge, [...path, prop]);
    },
    async apply(_target, _thisArg, args) {
      const toolPath = path.join(".");
      if (!toolPath) throw new Error("Tool path missing");
      const input = args.length > 0 ? args[0] : {};
      const callId = "call_" + crypto.randomUUID();

      while (true) {
        const result = await bridge.callTool(toolPath, input, callId);
        if (result.ok) return result.value;
        if (result.kind === "pending") {
          await sleep(Math.max(50, result.retryAfterMs ?? 500));
          continue;
        }
        if (result.kind === "denied") throw new Error(APPROVAL_DENIED_PREFIX + result.error);
        throw new Error(result.error);
      }
    },
  });
}

export default {
  async fetch(req, env, ctx) {
    const stdoutLines = [];
    const stderrLines = [];

    const appendStdout = (line) => {
      stdoutLines.push(line);
      ctx.waitUntil(env.TOOL_BRIDGE.emitOutput("stdout", line));
    };
    const appendStderr = (line) => {
      stderrLines.push(line);
      ctx.waitUntil(env.TOOL_BRIDGE.emitOutput("stderr", line));
    };

    const tools = createToolsProxy(env.TOOL_BRIDGE);
    const console = {
      log: (...args) => appendStdout(formatArgs(args)),
      info: (...args) => appendStdout(formatArgs(args)),
      warn: (...args) => appendStderr(formatArgs(args)),
      error: (...args) => appendStderr(formatArgs(args)),
    };

    try {
      const value = await run(tools, console);

      if (value !== undefined) {
        appendStdout("result: " + formatArgs([value]));
      }

      return _ResponseJson({
        status: "completed",
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
        exitCode: 0,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (message.startsWith(APPROVAL_DENIED_PREFIX)) {
        const denied = message.replace(APPROVAL_DENIED_PREFIX, "").trim();
        appendStderr(denied);
        return _ResponseJson({
          status: "denied",
          stdout: stdoutLines.join("\n"),
          stderr: stderrLines.join("\n"),
          error: denied,
        });
      }
      appendStderr(message);
      return _ResponseJson({
        status: "failed",
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
        error: message,
      });
    }
  },
};
