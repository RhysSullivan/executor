import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

import { makeCloudflareWorkerLoaderRuntimeAdapter } from "@executor-v2/runtime-cloudflare-worker-loader";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/runtime-local-inproc";
import {
  makeRuntimeAdapterRegistry,
  RuntimeAdapterError,
} from "./runtime-adapters";

describe("runtime adapters", () => {
  it.effect("executes with local-inproc adapter via runtime registry", () =>
    Effect.gen(function* () {
      const runtimeRegistry = makeRuntimeAdapterRegistry([
        makeLocalInProcessRuntimeAdapter(),
      ]);

      const result = yield* runtimeRegistry.execute({
        runtimeKind: "local-inproc",
        runId: "run_test_1",
        code: "return await tools.sum({ a: 2, b: 4 });",
        toolCallService: {
          callTool: (input) =>
            input.toolPath === "sum"
              ? Effect.succeed(
                  ((input.input?.a as number) ?? 0) +
                    ((input.input?.b as number) ?? 0),
                )
              : new RuntimeAdapterError({
                  operation: "call_tool",
                  runtimeKind: "local-inproc",
                  message: `Unknown tool path: ${input.toolPath}`,
                  details: null,
                }),
        },
      });

      expect(result).toBe(6);
    }),
  );

  it.effect("returns typed not-implemented error for cloudflare adapter", () =>
    Effect.gen(function* () {
      const runtimeRegistry = makeRuntimeAdapterRegistry([
        makeCloudflareWorkerLoaderRuntimeAdapter(),
      ]);

      const result = yield* Effect.either(
        runtimeRegistry.execute({
          runtimeKind: "cloudflare-worker-loader",
          runId: "run_test_2",
          code: "return 1;",
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(RuntimeAdapterError);
        if (result.left instanceof RuntimeAdapterError) {
          expect(result.left.runtimeKind).toBe("cloudflare-worker-loader");
        }
      }
    }),
  );
});
