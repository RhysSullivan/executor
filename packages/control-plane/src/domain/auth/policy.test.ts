import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { Actor, makeAllowAllActor } from "./actor";
import { requirePermission, withPolicy } from "./policy";

describe("control-plane-domain policy", () => {
  it.effect("runs protected effect when permission is granted", () =>
    Effect.gen(function* () {
      const principal = {
        accountId: "acc_1" as never,
        provider: "local" as const,
        subject: "local:acc_1",
        email: null,
        displayName: null,
      };

      const result = yield* withPolicy(
        requirePermission({
          permission: "workspace:read",
          workspaceId: "ws_1" as never,
        }),
      )(Effect.succeed("ok")).pipe(
        Effect.provideService(Actor, makeAllowAllActor(principal)),
      );

      expect(result).toBe("ok");
    }),
  );
});
