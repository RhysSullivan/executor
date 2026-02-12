import { ResponseJson as _ResponseJson } from "./globals.js";
import { run } from "./user-code.js";

const APPROVAL_DENIED_PREFIX = "APPROVAL_DENIED:";

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

      const result = await bridge.callTool(toolPath, input, callId);
      if (result.ok) return result.value;
      if (result.kind === "denied") throw new Error(APPROVAL_DENIED_PREFIX + result.error);
      throw new Error(result.error);
    },
  });
}

function sanitizeExecutionResult(value) {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    return JSON.parse(serialized);
  } catch {
    return String(value);
  }
}

export default {
  async fetch(req, env, _ctx) {
    const tools = createToolsProxy(env.TOOL_BRIDGE);
    const console = {
      log: (..._args) => {},
      info: (..._args) => {},
      warn: (..._args) => {},
      error: (..._args) => {},
    };

    try {
      const value = await run(tools, console);

      return _ResponseJson({
        status: "completed",
        result: sanitizeExecutionResult(value),
        exitCode: 0,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (message.startsWith(APPROVAL_DENIED_PREFIX)) {
        const denied = message.replace(APPROVAL_DENIED_PREFIX, "").trim();
        return _ResponseJson({
          status: "denied",
          error: denied,
        });
      }
      return _ResponseJson({
        status: "failed",
        error: message,
      });
    }
  },
};
