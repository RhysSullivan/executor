import type { App } from "@modelcontextprotocol/ext-apps";

/**
 * Creates a tRPC-style recursive proxy that maps dotted tool paths
 * to execute-action calls through the MCP Apps bridge.
 *
 * Usage: tools.github.issues.create({ title: "Bug" })
 * becomes: app.callServerTool("execute-action", { code: "return await tools.github.issues.create({\"title\":\"Bug\"})" })
 */
export function createToolsProxy(app: App): Record<string, unknown> {
  function nest(path: string[]): unknown {
    return new Proxy(function () {}, {
      get(_target, key: string) {
        if (key === "then" || key === "toJSON" || key === Symbol.toPrimitive as unknown) {
          return undefined;
        }
        return nest([...path, key]);
      },
      apply(_target, _thisArg, args: unknown[]) {
        const toolPath = path.join(".");
        const serializedArgs = args.length > 0 ? JSON.stringify(args[0]) : "{}";
        const code = `return await tools.${toolPath}(${serializedArgs})`;

        console.log("[executor-proxy] calling:", code);

        return app
          .callServerTool({
            name: "execute-action",
            arguments: { code },
          })
          .then((r) => {
            console.log("[executor-proxy] raw result:", JSON.stringify({
              isError: r.isError,
              structuredContent: r.structuredContent,
              text: r.content?.find((c) => c.type === "text")?.text,
            }));
            if (r.isError) {
              const msg =
                r.content?.find((c) => c.type === "text")?.text ?? "Tool call failed";
              throw new Error(msg);
            }
            const unwrapped = unwrapResult(r.structuredContent as Record<string, unknown>) ?? parseTextContent(r);
            console.log("[executor-proxy] unwrapped:", JSON.stringify(unwrapped));
            return unwrapped;
          });
      },
    });
  }

  return nest([]) as Record<string, unknown>;
}

/**
 * Creates the `run()` escape hatch for multi-step tool composition.
 *
 * Usage: const result = await run(`
 *   const me = await tools.github.users.me()
 *   return await tools.github.issues.create({ assignee: me.login, ... })
 * `)
 */
export function createRunFn(app: App): (code: string) => Promise<unknown> {
  return (code: string) =>
    app
      .callServerTool({
        name: "execute-action",
        arguments: { code },
      })
      .then((r) => {
        if (r.isError) {
          const msg =
            r.content?.find((c) => c.type === "text")?.text ?? "Execution failed";
          throw new Error(msg);
        }
        return unwrapResult(r.structuredContent as Record<string, unknown>) ?? parseTextContent(r);
      });
}

/**
 * Unwrap execution result. The kernel wraps results as
 * `{ status: "completed", result: <actual>, logs: [...] }`.
 * Return just the inner result value.
 */
function unwrapResult(structured: Record<string, unknown> | undefined | null): unknown {
  if (
    structured &&
    typeof structured === "object" &&
    "status" in structured &&
    "result" in structured
  ) {
    return structured.result;
  }
  return structured;
}

function parseTextContent(r: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
