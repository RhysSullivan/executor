/**
 * Build the ES module source that runs inside the dynamic Worker.
 *
 * The module exports a `WorkerEntrypoint` subclass with an `evaluate`
 * method that:
 * 1. Captures console output into `__logs`.
 * 2. Creates a recursive `tools` Proxy that dispatches calls via RPC.
 * 3. Executes the normalised user code with a `Promise.race` timeout.
 * 4. Returns `{ result, error?, logs }`.
 */
export const buildExecutorModule = (
  normalizedCode: string,
  timeoutMs: number,
): string =>
  [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    "",
    "export default class CodeExecutor extends WorkerEntrypoint {",
    "  async evaluate(__dispatcher) {",
    "    const __logs = [];",
    '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
    '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
    '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
    "",
    "    const __makeToolsProxy = (path = []) => new Proxy(() => undefined, {",
    "      get(_target, prop) {",
    "        if (prop === 'then' || typeof prop === 'symbol') return undefined;",
    "        return __makeToolsProxy([...path, String(prop)]);",
    "      },",
    "      apply(_target, _thisArg, args) {",
    "        const toolPath = path.join('.');",
    "        if (!toolPath) throw new Error('Tool path missing in invocation');",
    "        return __dispatcher.call(toolPath, JSON.stringify(args[0] ?? {})).then((raw) => {",
    "          const data = JSON.parse(raw);",
    "          if (data.error) throw new Error(data.error);",
    "          return data.result;",
    "        });",
    "      },",
    "    });",
    "    const tools = __makeToolsProxy();",
    "",
    "    try {",
    "      const result = await Promise.race([",
    `        (${normalizedCode})(),`,
    "        new Promise((_, reject) =>",
    `          setTimeout(() => reject(new Error("Execution timed out after ${timeoutMs}ms")), ${timeoutMs})`,
    "        ),",
    "      ]);",
    "      return { result, logs: __logs };",
    "    } catch (err) {",
    "      return { result: undefined, error: err.message ?? String(err), logs: __logs };",
    "    }",
    "  }",
    "}",
  ].join("\n");
