import { describe, expect, it } from "@effect/vitest";
import { assertInclude } from "@effect/vitest/utils";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { SandboxToolInvoker } from "@executor/codemode-core";
import { makeSecureExecExecutor } from "./index";

class UnknownToolError extends Data.TaggedError("UnknownToolError")<{
  readonly path: string;
}> {}

class ToolHandlerError extends Data.TaggedError("ToolHandlerError")<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

const makeTestInvoker = (
  handlers: Record<string, (args: unknown) => unknown | Promise<unknown>>,
): SandboxToolInvoker => ({
  invoke: ({ path, args }) => {
    const handler = handlers[path];
    if (!handler) {
      return Effect.fail(new UnknownToolError({ path }));
    }
    return Effect.tryPromise({
      try: () => Promise.resolve(handler(args)),
      catch: (cause) => new ToolHandlerError({ path, cause }),
    });
  },
});

const executor = makeSecureExecExecutor({ timeoutMs: 5_000 });

// secure-exec-v8 does not ship a Windows binary — skip on win32
describe.skipIf(process.platform === "win32")("secure-exec executor", () => {
  it.effect("runs plain code", () =>
    Effect.gen(function* () {
      const result = yield* executor.execute("return 1 + 2", makeTestInvoker({}));

      expect(result.result).toBe(3);
      expect(result.error).toBeUndefined();
    }),
  );

  it.effect("recovers prose-wrapped fenced async arrow input", () =>
    Effect.gen(function* () {
      const result = yield* executor.execute(
        ["Use this snippet.", "", "```ts", "async () => 42", "```"].join("\n"),
        makeTestInvoker({}),
      );

      expect(result.result).toBe(42);
      expect(result.error).toBeUndefined();
    }),
  );

  it.effect("invokes a tool and returns its result", () =>
    Effect.gen(function* () {
      const invoker = makeTestInvoker({
        "math.add": (args) => {
          const { a, b } = args as { a: number; b: number };
          return { sum: a + b };
        },
      });

      const result = yield* executor.execute(
        `
        const out = await tools.math.add({ a: 7, b: 5 });
        return out.sum;
        `,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe(12);
    }),
  );

  it.effect("captures console output as logs", () =>
    Effect.gen(function* () {
      const result = yield* executor.execute(
        `
        console.log("hello");
        console.warn("warn");
        return "done";
        `,
        makeTestInvoker({}),
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe("done");
      expect(result.logs).toContainEqual("[log] hello");
      expect(result.logs).toContainEqual("[warn] warn");
    }),
  );

  it.effect("supports async arrow-function source input", () =>
    Effect.gen(function* () {
      const result = yield* executor.execute(
        `
        async () => {
          return 42;
        }
        `,
        makeTestInvoker({}),
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe(42);
    }),
  );

  it.effect("supports catching tool invocation failures in user code", () =>
    Effect.gen(function* () {
      const invoker = makeTestInvoker({
        "db.query": () => {
          throw new Error("connection refused");
        },
      });

      const result = yield* executor.execute(
        `
        try {
          await tools.db.query({ sql: "SELECT 1" });
          return "unexpected";
        } catch (e) {
          return "caught: " + e.message;
        }
        `,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toContain("caught:");
      expect(result.result).toContain("connection refused");
    }),
  );

  it.live("enforces timeout", () =>
    Effect.gen(function* () {
      const shortTimeoutExecutor = makeSecureExecExecutor({ timeoutMs: 150 });

      const result = yield* shortTimeoutExecutor.execute(
        `
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return "done";
        `,
        makeTestInvoker({}),
      );

      expect(result.result).toBeNull();
      assertInclude(result.error, "timed out");
    }),
  );
});
