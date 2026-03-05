import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import {
  DenoSubprocessRunnerError,
  executeJavaScriptInDenoSubprocess,
} from "@executor-v2/runtime-deno-subprocess";

describe("executeJavaScriptInDenoSubprocess", () => {
  it.effect("runs code in Deno subprocess and proxies tool calls", () =>
    Effect.gen(function* () {
      const result = yield* executeJavaScriptInDenoSubprocess({
        runId: "run_deno_1",
        code: "console.log('hello'); return await tools.sum({ a: 2, b: 3 });",
        toolCallService: {
          callTool: (input) =>
            input.toolPath === "sum"
              ? Effect.succeed(
                  ((input.input?.a as number) ?? 0) +
                    ((input.input?.b as number) ?? 0),
                )
              : new DenoSubprocessRunnerError({
                  operation: "call_tool",
                  runtimeKind: "deno-subprocess",
                  message: `Unknown tool path: ${input.toolPath}`,
                  details: null,
                }),
        },
        timeoutMs: 10_000,
      });

      expect(result).toBe(5);
    }),
  );

  it.effect("returns a typed error when Deno executable is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        executeJavaScriptInDenoSubprocess({
          runId: "run_deno_2",
          code: "return 1;",
          denoExecutable: "/definitely-missing-deno-binary",
          timeoutMs: 1_000,
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(DenoSubprocessRunnerError);
        expect(result.left.operation).toBe("spawn");
      }
    }),
  );
});
