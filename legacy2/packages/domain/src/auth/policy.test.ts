import { describe, expect, it } from "@effect/vitest";
import {
  PrincipalSchema,
  WorkspaceIdSchema,
  WorkspaceMembershipSchema,
  type Role,
  type WorkspaceMembership,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { Actor, ActorForbiddenError, makeActor } from "./actor";
import { all, any, policy, requirePermission, withPolicy } from "./policy";

const decodePrincipal = Schema.decodeUnknownSync(PrincipalSchema);
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceIdSchema);
const decodeWorkspaceMembership = Schema.decodeUnknownSync(WorkspaceMembershipSchema);

const workspaceId = decodeWorkspaceId("ws_local");

const principal = decodePrincipal({
  accountId: "acct_local",
  provider: "local",
  subject: "local:acct_local",
  email: "dev@example.com",
  displayName: "Dev User",
});

const membershipForRole = (role: Role): WorkspaceMembership =>
  decodeWorkspaceMembership({
    accountId: "acct_local",
    workspaceId,
    role,
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
  });

const actorLayerForRole = (role: Role) =>
  Layer.effect(
    Actor,
    makeActor({
      principal,
      workspaceMemberships: [membershipForRole(role)],
      organizationMemberships: [],
    }),
  );

const runWithRole = <A, E>(role: Role, effect: Effect.Effect<A, E, Actor>) =>
  Effect.either(effect.pipe(Effect.provide(actorLayerForRole(role))));

describe("policy primitives", () => {
  it.effect("withPolicy executes protected effect when permission is allowed", () =>
    Effect.gen(function* () {
      const protectedEffect = withPolicy(
        requirePermission({
          permission: "sources:write",
          workspaceId,
        }),
      )(Effect.succeed("ok"));

      const result = yield* runWithRole("editor", protectedEffect);

      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right).toBe("ok");
      }
    }),
  );

  it.effect("withPolicy blocks protected effect when permission is denied", () =>
    Effect.gen(function* () {
      const protectedEffect = withPolicy(
        requirePermission({
          permission: "sources:write",
          workspaceId,
        }),
      )(Effect.succeed("ok"));

      const result = yield* runWithRole("viewer", protectedEffect);

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ActorForbiddenError");
      }
    }),
  );

  it.effect("all requires every policy to succeed", () =>
    Effect.gen(function* () {
      const p1 = requirePermission({
        permission: "sources:read",
        workspaceId,
      });
      const p2 = requirePermission({
        permission: "sources:write",
        workspaceId,
      });

      const protectedEffect = withPolicy(all([p1, p2]))(Effect.succeed("ok"));

      const editorResult = yield* runWithRole("editor", protectedEffect);
      const viewerResult = yield* runWithRole("viewer", protectedEffect);

      expect(Either.isRight(editorResult)).toBe(true);
      expect(Either.isLeft(viewerResult)).toBe(true);
    }),
  );

  it.effect("any succeeds when one policy succeeds", () =>
    Effect.gen(function* () {
      const needsRead = requirePermission({
        permission: "sources:read",
        workspaceId,
      });
      const needsManage = requirePermission({
        permission: "sources:manage",
        workspaceId,
      });

      const protectedEffect = withPolicy(any([needsManage, needsRead]))(
        Effect.succeed("ok"),
      );

      const result = yield* runWithRole("viewer", protectedEffect);

      expect(Either.isRight(result)).toBe(true);
    }),
  );

  it.effect("policy helper can define custom forbidden predicate", () =>
    Effect.gen(function* () {
      const alwaysDenied = policy(
        () => Effect.succeed(false),
        () =>
          new ActorForbiddenError({
            permission: "sources:manage",
            scope: `workspace:${workspaceId}`,
          }),
      );

      const result = yield* runWithRole("owner", alwaysDenied);

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ActorForbiddenError");
        if (result.left._tag === "ActorForbiddenError") {
          expect(result.left.permission).toBe("sources:manage");
        }
      }
    }),
  );
});
