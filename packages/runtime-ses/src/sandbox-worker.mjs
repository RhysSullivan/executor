import "ses";

lockdown({
  errorTaming: "unsafe",
  overrideTaming: "moderate",
  consoleTaming: "unsafe",
  stackFiltering: "verbose",
});

const pendingToolCalls = new Map();
let nextCallId = 1;

const formatLogArg = (value) => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const formatLogLine = (args) => args.map(formatLogArg).join(" ");

const buildExecutionSource = (code) => {
  const trimmed = code.trim();
  const looksLikeArrowFunction =
    (trimmed.startsWith("async") || trimmed.startsWith("(")) && trimmed.includes("=>");

  if (looksLikeArrowFunction) {
    return [
      '"use strict";',
      "(async () => {",
      `const __fn = (${trimmed});`,
      "if (typeof __fn !== 'function') throw new Error('Code must evaluate to a function');",
      "return await __fn();",
      "})()",
    ].join("\n");
  }

  return [
    '"use strict";',
    "(async () => {",
    code,
    "})()",
  ].join("\n");
};

const addGlobal = (globals, key, value) => {
  if (typeof value !== "undefined") {
    globals[key] = value;
  }
};

const makeToolsProxy = (path = []) =>
  new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") {
        return undefined;
      }

      return makeToolsProxy([...path, prop]);
    },
    apply(_target, _thisArg, args) {
      const toolPath = path.join(".");
      if (!toolPath) {
        throw new Error("Tool path missing in invocation");
      }

      const callId = `call_${nextCallId++}`;
      return new Promise((resolve, reject) => {
        pendingToolCalls.set(callId, { resolve, reject });
        process.send?.({
          type: "tool-call",
          callId,
          path: toolPath,
          args: args[0],
        });
      });
    },
  });

const blockedFetch = async (..._args) => {
  throw new Error("fetch is disabled in SES executor");
};

const createGlobals = ({ logs, allowFetch }) => {
  const globals = {
    tools: makeToolsProxy(),
    console: {
      log: (...args) => {
        logs.push(`[log] ${formatLogLine(args)}`);
      },
      warn: (...args) => {
        logs.push(`[warn] ${formatLogLine(args)}`);
      },
      error: (...args) => {
        logs.push(`[error] ${formatLogLine(args)}`);
      },
    },
    fetch: allowFetch ? fetch : blockedFetch,
  };

  addGlobal(globals, "setTimeout", globalThis.setTimeout);
  addGlobal(globals, "clearTimeout", globalThis.clearTimeout);
  addGlobal(globals, "setInterval", globalThis.setInterval);
  addGlobal(globals, "clearInterval", globalThis.clearInterval);
  addGlobal(globals, "URL", globalThis.URL);
  addGlobal(globals, "URLSearchParams", globalThis.URLSearchParams);
  addGlobal(globals, "AbortController", globalThis.AbortController);
  addGlobal(globals, "AbortSignal", globalThis.AbortSignal);
  addGlobal(globals, "Headers", globalThis.Headers);
  addGlobal(globals, "Request", globalThis.Request);
  addGlobal(globals, "Response", globalThis.Response);
  addGlobal(globals, "TextEncoder", globalThis.TextEncoder);
  addGlobal(globals, "TextDecoder", globalThis.TextDecoder);
  addGlobal(globals, "structuredClone", globalThis.structuredClone);
  addGlobal(globals, "crypto", globalThis.crypto);

  return globals;
};

process.on("message", async (message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "tool-response") {
    const pending = pendingToolCalls.get(message.callId);
    if (!pending) {
      return;
    }

    pendingToolCalls.delete(message.callId);

    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }

    pending.resolve(message.value);
    return;
  }

  if (message.type === "evaluate") {
    const logs = [];

    try {
      const compartment = new Compartment({
        globals: createGlobals({ logs, allowFetch: message.allowFetch === true }),
        __options__: true,
      });
      const result = await compartment.evaluate(buildExecutionSource(message.code));

      process.send?.({
        type: "result",
        id: message.id,
        value: result,
        logs,
      });
    } catch (error) {
      process.send?.({
        type: "result",
        id: message.id,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        logs,
      });
    }
  }
});

process.send?.({ type: "ready" });
