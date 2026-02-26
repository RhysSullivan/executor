import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  PmToolCallHandler,
  PmToolCallHandlerLive,
  PmToolCallHttpHandler,
  PmToolCallHttpHandlerLive,
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

  it.effect("decodes callback request payload and returns JSON result", () =>
    Effect.gen(function* () {
      const httpHandler = yield* PmToolCallHttpHandler;

      const response = yield* Effect.tryPromise(() =>
        httpHandler.handleToolCallHttp(
          new Request("http://127.0.0.1/runtime/tool-call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              runId: "run_2",
              callId: "call_2",
              toolPath: "tools.example.weather",
              input: { city: "London" },
            }),
          }),
        ),
      );

      expect(response.status).toBe(200);

      const payload = (yield* Effect.tryPromise(() => response.json())) as {
        ok: boolean;
        kind?: string;
        error?: string;
      };

      expect(payload.ok).toBe(false);
      expect(payload.kind).toBe("failed");
      expect(payload.error).toContain("tools.example.weather");
    }).pipe(
      Effect.provide(
        PmToolCallHttpHandlerLive.pipe(Layer.provide(PmToolCallHandlerLive)),
      ),
    ),
  );
});
