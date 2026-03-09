import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  createCodeTool,
} from "@executor/ai-sdk-adapter/ai";
import {
  allowAllToolInteractions,
  makeToolInvokerFromTools,
  toExecutorTool,
} from "@executor/codemode-core";
import { makeSesExecutor } from "@executor/runtime-ses";

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
  it.effect("executes code with SES runtime", () =>
    Effect.gen(function* () {
      const executor = makeSesExecutor();
      const toolInvoker = makeToolInvokerFromTools({
        tools,
        onToolInteraction: allowAllToolInteractions,
      });

      const output = yield* executor.execute(
        [
          "const math = await tools.math.add({ a: 19, b: 23 });",
          "await tools.notifications.send({ message: `sum is ${math.sum}` });",
          "return math;",
        ].join("\n"),
        toolInvoker,
      );

      expect(output.result).toEqual({ sum: 42 });
    }),
  );

  it.effect("executes through lazy tool invoker", () =>
    Effect.gen(function* () {
      const executor = makeSesExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executor.execute(
        "return await tools.math.add({ a: 40, b: 2 });",
        toolInvoker,
      );

      expect(output.result).toEqual({ sum: 42 });
    }),
  );

  it.effect("does not expose process inside SES sandbox", () =>
    Effect.gen(function* () {
      const executor = makeSesExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executor.execute("return typeof process;", toolInvoker);

      expect(output.result).toBe("undefined");
    }),
  );

  it.effect("createCodeTool wraps Effect execution for AI SDK", () =>
    Effect.gen(function* () {
      const executor = makeSesExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });
      const codemode = createCodeTool({ toolInvoker, executor });
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
      const executor = makeSesExecutor();
      const toolInvoker = makeToolInvokerFromTools({ tools });

      const output = yield* executor.execute(
        'await fetch("https://example.com"); return 1;',
        toolInvoker,
      );

      expect(output.error).toContain("fetch is disabled in SES executor");
    }),
  );
});
