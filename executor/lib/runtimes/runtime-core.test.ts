import { expect, test } from "bun:test";
import { runCodeWithAdapter } from "./runtime_core";
import { loadExternalTools } from "../tool_sources";
import type {
  ExecutionAdapter,
  RuntimeOutputEvent,
  SandboxExecutionRequest,
  ToolDefinition,
  ToolRunContext,
} from "../types";

function request(code: string, timeoutMs = 1_000): SandboxExecutionRequest {
  return {
    taskId: `task_${crypto.randomUUID()}`,
    code,
    timeoutMs,
  };
}

function createRuntimeAdapter(
  tools: Map<string, ToolDefinition>,
  outputEvents: RuntimeOutputEvent[],
): ExecutionAdapter {
  return {
    async invokeTool(call) {
      const tool = tools.get(call.toolPath);
      if (!tool) {
        return {
          ok: false,
          error: `Tool not found: ${call.toolPath}`,
        };
      }

      try {
        const context: ToolRunContext = {
          taskId: call.runId,
          workspaceId: "ws_test",
          actorId: "actor_test",
          clientId: "web",
          isToolAllowed: () => true,
        };
        const value = await tool.run(call.input, context);
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    emitOutput(event) {
      outputEvents.push(event);
    },
  };
}

test("executes tool calls and captures output", async () => {
  const outputEvents: RuntimeOutputEvent[] = [];
  const tools = new Map<string, ToolDefinition>([
    [
      "utils.echo",
      {
        path: "utils.echo",
        description: "Echo back input",
        approval: "auto",
        run: async (input) => ({ echoed: input }),
      },
    ],
  ]);

  const result = await runCodeWithAdapter(
    request(`
      const out = await tools.utils.echo({ message: "hi" });
      console.log("out", out.echoed.message);
      return 42;
    `),
    createRuntimeAdapter(tools, outputEvents),
  );

  expect(result.status).toBe("completed");
  expect(result.stdout).toContain("out hi");
  expect(result.stdout).toContain("result: 42");
  expect(outputEvents.some((event) => event.stream === "stdout")).toBe(true);
});

test("returns denied when adapter marks tool call denied", async () => {
  const adapter: ExecutionAdapter = {
    async invokeTool() {
      return {
        ok: false,
        denied: true,
        error: "policy denied",
      };
    },
    emitOutput() {},
  };

  const result = await runCodeWithAdapter(
    request(`
      await tools.admin.delete_data({ id: "x" });
    `),
    adapter,
  );

  expect(result.status).toBe("denied");
  expect(result.error).toBe("policy denied");
  expect(result.stderr).toContain("policy denied");
});

test("times out long-running code", async () => {
  const adapter: ExecutionAdapter = {
    async invokeTool() {
      return { ok: true, value: null };
    },
    emitOutput() {},
  };

  const result = await runCodeWithAdapter(
    request(
      `
      await new Promise(() => {});
    `,
      25,
    ),
    adapter,
  );

  expect(result.status).toBe("timed_out");
  expect(result.error).toContain("timed out");
});

test("sandboxed runner does not expose host globals", async () => {
  const outputEvents: RuntimeOutputEvent[] = [];
  const adapter = createRuntimeAdapter(new Map(), outputEvents);

  const result = await runCodeWithAdapter(
    request(`
      let fsEscape = "unknown";
      try {
        fsEscape = [].constructor.constructor("return typeof process")();
      } catch {
        fsEscape = "blocked";
      }

      const checks = {
        process: typeof process,
        bun: typeof Bun,
        fetch: typeof fetch,
        fsEscape,
      };
      console.log(JSON.stringify(checks));
      if (checks.process !== "undefined") throw new Error("process leaked");
      if (checks.bun !== "undefined") throw new Error("Bun leaked");
      if (checks.fetch !== "undefined") throw new Error("fetch leaked");
      if (checks.fsEscape !== "undefined" && checks.fsEscape !== "blocked") {
        throw new Error("constructor escape leaked");
      }
      return "ok";
    `),
    adapter,
  );

  expect(result.status).toBe("completed");
  expect(result.stdout).toContain("\"process\":\"undefined\"");
  expect(result.stdout).toContain("\"bun\":\"undefined\"");
  expect(result.stdout).toContain("\"fetch\":\"undefined\"");
  expect(result.stdout).toMatch(/"fsEscape":"(undefined|blocked)"/);
});

test("sandbox blocks global constructor and eval escapes", async () => {
  const adapter = createRuntimeAdapter(new Map(), []);

  const result = await runCodeWithAdapter(
    request(`
      let ctorEscape = "unknown";
      let evalEscape = "unknown";
      let functionEscape = "unknown";

      try {
        ctorEscape = globalThis.constructor.constructor("return typeof process")();
      } catch {
        ctorEscape = "blocked";
      }

      try {
        evalEscape = eval("typeof process");
      } catch {
        evalEscape = "blocked";
      }

      try {
        functionEscape = Function("return typeof process")();
      } catch {
        functionEscape = "blocked";
      }

      console.log(JSON.stringify({ ctorEscape, evalEscape, functionEscape }));
      if (ctorEscape !== "undefined" && ctorEscape !== "blocked") throw new Error("ctor escape");
      if (evalEscape !== "undefined" && evalEscape !== "blocked") throw new Error("eval escape");
      if (functionEscape !== "undefined" && functionEscape !== "blocked") throw new Error("Function escape");
    `),
    adapter,
  );

  expect(result.status).toBe("completed");
  expect(result.stdout).toMatch(/"ctorEscape":"(undefined|blocked)"/);
  expect(result.stdout).toMatch(/"evalEscape":"(undefined|blocked)"/);
  expect(result.stdout).toMatch(/"functionEscape":"(undefined|blocked)"/);
});

test("sandbox prototype pollution does not leak to host", async () => {
  const marker = `__pwned_${crypto.randomUUID().replace(/-/g, "")}`;
  expect(({} as Record<string, unknown>)[marker]).toBeUndefined();

  const adapter = createRuntimeAdapter(new Map(), []);
  const result = await runCodeWithAdapter(
    request(`
      Object.prototype[${JSON.stringify(marker)}] = "yes";
      return "done";
    `),
    adapter,
  );

  expect(result.status).toBe("completed");
  expect(({} as Record<string, unknown>)[marker]).toBeUndefined();
});

test("runs openapi and graphql sourced tools through the runtime", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/add" && req.method === "GET") {
        const a = Number(url.searchParams.get("a") ?? "0");
        const b = Number(url.searchParams.get("b") ?? "0");
        return Response.json({ sum: a + b });
      }

      if (url.pathname === "/graphql" && req.method === "POST") {
        const body = (await req.json()) as { query?: string; variables?: Record<string, unknown> };
        const query = String(body.query ?? "");

        if (query.includes("__schema")) {
          return Response.json({
            data: {
              __schema: {
                queryType: { name: "Query" },
                mutationType: { name: "Mutation" },
                types: [
                  {
                    kind: "OBJECT",
                    name: "Query",
                    fields: [
                      {
                        name: "hello",
                        description: null,
                        args: [],
                        type: { kind: "SCALAR", name: "String", ofType: null },
                      },
                    ],
                    inputFields: null,
                    enumValues: null,
                  },
                  {
                    kind: "OBJECT",
                    name: "Mutation",
                    fields: [
                      {
                        name: "increment",
                        description: null,
                        args: [
                          {
                            name: "value",
                            description: null,
                            defaultValue: null,
                            type: {
                              kind: "NON_NULL",
                              name: null,
                              ofType: { kind: "SCALAR", name: "Int", ofType: null },
                            },
                          },
                        ],
                        type: { kind: "SCALAR", name: "Int", ofType: null },
                      },
                    ],
                    inputFields: null,
                    enumValues: null,
                  },
                  { kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null },
                  { kind: "SCALAR", name: "Int", fields: null, inputFields: null, enumValues: null },
                ],
              },
            },
          });
        }

        if (query.includes("hello")) {
          return Response.json({ data: { hello: "world" } });
        }

        if (query.includes("increment")) {
          const value = Number(body.variables?.value ?? 0);
          return Response.json({ data: { increment: value + 1 } });
        }

        return Response.json({ errors: [{ message: "Unknown query" }] }, { status: 400 });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const { tools } = await loadExternalTools([
      {
        type: "openapi",
        name: "calc",
        baseUrl,
        spec: {
          openapi: "3.0.3",
          info: { title: "Calc", version: "1.0.0" },
          paths: {
            "/add": {
              get: {
                operationId: "addNumbers",
                tags: ["math"],
                parameters: [
                  { name: "a", in: "query", required: true, schema: { type: "number" } },
                  { name: "b", in: "query", required: true, schema: { type: "number" } },
                ],
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { sum: { type: "number" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        type: "graphql",
        name: "gql",
        endpoint: `${baseUrl}/graphql`,
      },
    ]);

    const toolMap = new Map(tools.map((tool) => [tool.path, tool]));
    const outputEvents: RuntimeOutputEvent[] = [];

    const result = await runCodeWithAdapter(
      request(`
        const sum = await tools.calc.math.add_numbers({ a: 2, b: 5 });
        const hello = await tools.gql.query.hello({});
        const inc = await tools.gql.graphql({
          query: "mutation($value: Int!) { increment(value: $value) }",
          variables: { value: 3 },
        });
        console.log("sum", sum.sum);
        console.log("hello", hello.data);
        console.log("inc", inc.data.increment);
        return sum.sum + inc.data.increment;
      `),
      createRuntimeAdapter(toolMap, outputEvents),
    );

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("sum 7");
    expect(result.stdout).toContain("hello world");
    expect(result.stdout).toContain("inc 4");
    expect(result.stdout).toContain("result: 11");
    expect(outputEvents.length).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
});
