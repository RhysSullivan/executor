import { ToolInvocationServiceLive } from "@executor-v2/domain";
import { LocalStateStoreService } from "@executor-v2/persistence-local";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PmCredentialResolverLive } from "./credential-resolver";
import { handleToolCallBody } from "./tool-call-handler";

const EmptyLocalStateStoreLive = Layer.succeed(LocalStateStoreService, {
  getSnapshot: () => Effect.succeed(Option.none()),
  writeSnapshot: () => Effect.void,
  readEvents: () => Effect.succeed([]),
  appendEvents: () => Effect.void,
});

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
    }).pipe(
      Effect.provide(
        ToolInvocationServiceLive("pm").pipe(
          Layer.provide(
            PmCredentialResolverLive.pipe(Layer.provide(EmptyLocalStateStoreLive)),
          ),
        ),
      ),
    ),
  );
});
