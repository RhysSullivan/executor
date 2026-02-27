import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  handleToolCallBody,
  PmToolCallHandler,
  PmToolCallHandlerLive,
} from "./tool-call-handler";

describe("PM runtime tool-call handling", () => {
  it.effect("returns failed result while callback invocation is unwired", () =>
    Effect.gen(function* () {
      const handler = yield* PmToolCallHandler;

      const result = yield* handler.handleToolCall({
        runId: "run_1",
        callId: "call_1",
        toolPath: "tools.example.lookup",
        input: { query: "ping" },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("failed");
        expect(result.error).toContain("tools.example.lookup");
      }
    }).pipe(Effect.provide(PmToolCallHandlerLive)),
  );

  it.effect("decodes callback request payload and returns failed callback result", () =>
    Effect.gen(function* () {
      const result = yield* handleToolCallBody({
        runId: "run_2",
        callId: "call_2",
        toolPath: "tools.example.weather",
        input: { city: "London" },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("failed");
        expect(result.error).toContain("tools.example.weather");
      }
    }).pipe(Effect.provide(PmToolCallHandlerLive)),
  );
});
