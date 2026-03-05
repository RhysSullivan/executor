import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeActor,
  ActorForbiddenError,
  ActorUnauthenticatedError,
} from "./actor";

describe("control-plane-domain actor", () => {
  it.effect("allows workspace permissions from active membership", () =>
    Effect.gen(function* () {
      const actor = yield* makeActor({
        principal: {
          accountId: "acc_1" as never,
          provider: "local",
          subject: "local:acc_1",
          email: null,
          displayName: null,
        },
        workspaceMemberships: [
          {
            accountId: "acc_1" as never,
            workspaceId: "ws_1" as never,
            role: "editor",
            status: "active",
            grantedAt: 1,
            updatedAt: 1,
          },
        ],
        organizationMemberships: [],
      });

      yield* actor.requirePermission({
        permission: "sources:write",
        workspaceId: "ws_1" as never,
      });
    }),
  );

  it.effect("denies permission when role is insufficient", () =>
    Effect.gen(function* () {
      const actor = yield* makeActor({
        principal: {
          accountId: "acc_1" as never,
          provider: "local",
          subject: "local:acc_1",
          email: null,
          displayName: null,
        },
        workspaceMemberships: [
          {
            accountId: "acc_1" as never,
            workspaceId: "ws_1" as never,
            role: "viewer",
            status: "active",
            grantedAt: 1,
            updatedAt: 1,
          },
        ],
        organizationMemberships: [],
      });

      const denied = yield* Effect.either(
        actor.requirePermission({
          permission: "sources:write",
          workspaceId: "ws_1" as never,
        }),
      );

      expect(denied._tag).toBe("Left");
      if (denied._tag === "Left") {
        expect(denied.left).toBeInstanceOf(ActorForbiddenError);
      }
    }),
  );

  it.effect("fails when principal is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        makeActor({
          principal: null,
          workspaceMemberships: [],
          organizationMemberships: [],
        }),
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ActorUnauthenticatedError);
      }
    }),
  );
});
