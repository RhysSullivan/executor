import { describe, expect, it } from "@effect/vitest";
import { convexTest } from "convex-test";
import * as Effect from "effect/Effect";

import { api } from "./_generated/api";
import { unwrapRpcSuccess } from "./rpc_exit";
import schema from "./schema";

const setup = () =>
  convexTest(schema, {
    "./http.ts": () => import("./http"),
    "./mcp.ts": () => import("./mcp"),
    "./executor.ts": () => import("./executor"),
    "./runtimeCallbacks.ts": () => import("./runtimeCallbacks"),
    "./_generated/api.js": () => import("./_generated/api.js"),
  });

describe("Convex executor actions", () => {
  it.effect("executes code via executeRun action", () =>
    Effect.gen(function* () {
      const t = setup();

      const result = unwrapRpcSuccess<{
        status: string;
        result?: unknown;
      }>(
        yield* Effect.tryPromise(() =>
          t.action(api.executor.executeRun, {
            code: "return 6 * 7;",
          }),
        ),
        "executor.executeRun",
      );

      expect(result.status).toBe("completed");
      expect(result.result).toBe(42);
    }),
  );

  it.effect("returns failed callback result from runtime callback action", () =>
    Effect.gen(function* () {
      const t = setup();

      const result = unwrapRpcSuccess<{
        ok: boolean;
        kind?: string;
        error?: string;
      }>(
        yield* Effect.tryPromise(() =>
          t.action(api.runtimeCallbacks.handleToolCall, {
            runId: "run_1",
            callId: "call_1",
            toolPath: "tools.example.lookup",
            input: { query: "ping" },
          }),
        ),
        "runtimeCallbacks.handleToolCall",
      );

      expect(result.ok).toBe(false);
      expect(result.kind).toBe("failed");
      expect(result.error).toContain("tools.example.lookup");
    }),
  );
});
