import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { SandboxToolInvoker } from "@executor/codemode-core";
import { ToolDispatcher } from "./executor";
import { makeDynamicWorkerExecutor } from "./executor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class TestToolError extends Data.TaggedError("TestToolError")<{
  readonly message: string;
}> {}

const makeInvoker = (
  fn: (input: { path: string; args: unknown }) => unknown,
): SandboxToolInvoker => ({
  invoke: (input) => Effect.try(() => fn(input)),
});

const failingInvoker = (message: string): SandboxToolInvoker => ({
  invoke: () => Effect.fail(new TestToolError({ message })),
});

// ---------------------------------------------------------------------------
// ToolDispatcher
// ---------------------------------------------------------------------------

describe("ToolDispatcher", () => {
  it("returns JSON result on successful tool call", async () => {
    const invoker = makeInvoker(({ args }) => args);
    const dispatcher = new ToolDispatcher(invoker);

    const result = await dispatcher.call("test.tool", '{"key":"value"}');
    expect(JSON.parse(result)).toEqual({ result: { key: "value" } });
  });

  it("returns JSON error when tool invocation fails", async () => {
    const dispatcher = new ToolDispatcher(failingInvoker("tool broke"));

    const result = await dispatcher.call("broken.tool", "{}");
    expect(JSON.parse(result)).toEqual({ error: "tool broke" });
  });

  it("handles undefined args", async () => {
    const invoker = makeInvoker(({ args }) => args);
    const dispatcher = new ToolDispatcher(invoker);

    const result = await dispatcher.call("test.tool", "");
    expect(JSON.parse(result)).toEqual({ result: undefined });
  });

  it("passes the tool path correctly", async () => {
    let capturedPath = "";
    const invoker = makeInvoker(({ path }) => {
      capturedPath = path;
      return "ok";
    });
    const dispatcher = new ToolDispatcher(invoker);

    await dispatcher.call("my.deep.tool.path", "{}");
    expect(capturedPath).toBe("my.deep.tool.path");
  });
});

// ---------------------------------------------------------------------------
// Full execution via makeDynamicWorkerExecutor
// ---------------------------------------------------------------------------

describe("makeDynamicWorkerExecutor", () => {
  const loader = (env as { LOADER: WorkerLoader }).LOADER;

  it("executes simple code and returns result", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(executor.execute("async () => 42", invoker));

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(42);
  });

  it("executes code that returns an object", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute('async () => ({ hello: "world" })', invoker),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ hello: "world" });
  });

  it("captures console output in logs", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute(
        'async () => { console.log("hello"); console.warn("careful"); return 1; }',
        invoker,
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.logs).toContain("hello");
    expect(result.logs).toContain("[warn] careful");
  });

  it("returns error for throwing code", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute('async () => { throw new Error("boom"); }', invoker),
    );

    expect(result.error).toBe("boom");
    expect(result.result).toBeNull();
  });

  it("invokes tools via the proxy and returns results", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(({ path, args }) => {
      if (path === "math.add") {
        const { a, b } = args as { a: number; b: number };
        return a + b;
      }
      return null;
    });

    const result = await Effect.runPromise(
      executor.execute(
        "async () => { const sum = await tools.math.add({ a: 3, b: 4 }); return sum; }",
        invoker,
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(7);
  });

  it("surfaces tool errors in execution result", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = failingInvoker("not authorized");

    const result = await Effect.runPromise(
      executor.execute("async () => { return await tools.secret.read({}); }", invoker),
    );

    expect(result.error).toBe("not authorized");
  });

  it("handles multiple tool calls in sequence", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(({ path }) => {
      if (path === "data.first") return 10;
      if (path === "data.second") return 20;
      return 0;
    });

    const result = await Effect.runPromise(
      executor.execute(
        `async () => {
          const a = await tools.data.first({});
          const b = await tools.data.second({});
          return a + b;
        }`,
        invoker,
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(30);
  });

  it("respects timeout", async () => {
    const executor = makeDynamicWorkerExecutor({ loader, timeoutMs: 500 });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute("async () => { await new Promise(r => setTimeout(r, 5000)); }", invoker),
    );

    expect(result.error).toContain("timed out");
  });

  it("blocks fetch when globalOutbound is null", async () => {
    const executor = makeDynamicWorkerExecutor({ loader, globalOutbound: null });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute('async () => { await fetch("https://example.com"); }', invoker),
    );

    expect(result.error).toBeDefined();
  });
});
