const encoder = new TextEncoder();
const IPC_PREFIX = "@@engine-ipc@@";

const pendingToolCalls = new Map();
let started = false;

const writeMessage = (message) => {
  const payload = `${IPC_PREFIX}${JSON.stringify(message)}\n`;
  Deno.stdout.writeSync(encoder.encode(payload));
};

const toErrorMessage = (error) => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
};

const createToolCaller = (toolPath) => (args) =>
  new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingToolCalls.set(requestId, { resolve, reject });

    writeMessage({
      type: "tool_call",
      requestId,
      toolPath,
      args: args === undefined ? {} : args,
    });
  });

const createToolsProxy = (path = []) => {
  const callable = () => undefined;

  return new Proxy(callable, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (typeof prop !== "string") return undefined;
      return createToolsProxy([...path, prop]);
    },
    apply(_target, _thisArg, args) {
      const toolPath = path.join(".");
      if (!toolPath) {
        throw new Error("Tool path missing in invocation");
      }

      return createToolCaller(toolPath)(args.length > 0 ? args[0] : undefined);
    },
  });
};

const runUserCode = async (code) => {
  const tools = createToolsProxy();

  const execute = new Function(
    "tools",
    `"use strict"; return (async () => {\n${code}\n})();`,
  );

  return await execute(tools);
};

const handleStart = (message) => {
  if (started) {
    writeMessage({
      type: "failed",
      error: "start message already received",
    });
    return;
  }

  started = true;

  runUserCode(message.code)
    .then((result) => {
      writeMessage({
        type: "completed",
        result,
      });
    })
    .catch((error) => {
      writeMessage({
        type: "failed",
        error: toErrorMessage(error),
      });
    });
};

const handleToolResult = (message) => {
  const pending = pendingToolCalls.get(message.requestId);
  if (!pending) {
    return;
  }

  pendingToolCalls.delete(message.requestId);

  if (message.ok) {
    pending.resolve(message.value);
    return;
  }

  pending.reject(new Error(message.error));
};

const handleHostMessage = (message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "start") {
    handleStart(message);
    return;
  }

  if (message.type === "tool_result") {
    handleToolResult(message);
  }
};

const decodeLines = async () => {
  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) {
        break;
      }

      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);

      if (line.length === 0) {
        continue;
      }

      try {
        const message = JSON.parse(line);
        handleHostMessage(message);
      } catch (error) {
        writeMessage({
          type: "failed",
          error: `invalid host message: ${toErrorMessage(error)}`,
        });
      }
    }
  }
};

await decodeLines();