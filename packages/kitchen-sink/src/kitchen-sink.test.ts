import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  allowAllToolInteractions,
  createCodeTool,
  executeCodeWithTools,
  makeToolInvokerFromTools,
  toExecutorTool,
} from "@executor-v3/ai-sdk-adapter/ai";
import { makeInProcessExecutor } from "@executor-v3/runtime-local-inproc";

const numberPairInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    a: Schema.Number,
    b: Schema.Number,
  }),
);

const messageInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    message: Schema.String,
  }),
);


const tools = {
  "math.add": {
    description: "Add two numbers",
    inputSchema: numberPairInputSchema,
    execute: ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
  },
  "notifications.send": toExecutorTool({
    tool: {
      description: "Send a message",
      inputSchema: messageInputSchema,
      execute: ({ message }: { message: string }) => ({ delivered: true, message }),
    },
    metadata: {
      interaction: "required",
    },
  }),
};

describe("kitchen-sink", () => {
  it.effect("executes code with in-process runtime", () =>
    Effect.gen(function* () {
      const executor = makeInProcessExecutor();

      const output = yield* executeCodeWithTools({
        code: [
          "const math = await tools.math.add({ a: 19, b: 23 });",
          "await tools.notifications.send({ message: `sum is ${math.sum}` });",
          "return math;",
        ].join("\n"),
        tools,
        executor,
        onToolInteraction: allowAllToolInteractions,
      });

      expect(output.result).toEqual({ sum: 42 });
    }),
  );

  it.effect("executes through lazy tool invoker", () =>
    Effect.gen(function* () {
      const executor = makeInProcessExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executeCodeWithTools({
        code: "return await tools.math.add({ a: 40, b: 2 });",
        executor,
        toolInvoker,
      });

      expect(output.result).toEqual({ sum: 42 });
    }),
  );

  it.effect("createCodeTool wraps Effect execution for AI SDK", () =>
    Effect.gen(function* () {
      const executor = makeInProcessExecutor();
      const codemode = createCodeTool({ tools, executor });
      const execute = (codemode as unknown as {
        execute?: (input: { code: string }) => Promise<unknown>;
      }).execute;

      if (!execute) {
        return yield* Effect.fail(new Error("Code tool execute function is missing"));
      }

      const output = yield* Effect.tryPromise({
        try: () => execute({ code: "return await tools.math.add({ a: 1, b: 2 });" }),
        catch: (cause: unknown) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });

      expect(output).toEqual({
        code: "return await tools.math.add({ a: 1, b: 2 });",
        result: { sum: 3 },
        logs: [],
      });
    }),
  );

  it.effect("fetch is disabled by default", () =>
    Effect.gen(function* () {
      const executor = makeInProcessExecutor();

      const outcome = yield* Effect.either(
        executeCodeWithTools({
          code: 'await fetch("https://example.com"); return 1;',
          tools,
          executor,
        }),
      );

      expect(outcome._tag).toBe("Left");
      if (outcome._tag === "Left") {
        expect(outcome.left.message).toContain("fetch is disabled in in-process executor");
      }
    }),
  );
});
