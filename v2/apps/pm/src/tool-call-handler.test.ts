import { ToolInvocationServiceUnwiredLive } from "@executor-v2/domain";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { handleToolCallBody } from "./tool-call-handler";

describe("PM runtime tool-call handling", () => {
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
    }).pipe(Effect.provide(ToolInvocationServiceUnwiredLive("pm"))),
  );
});
