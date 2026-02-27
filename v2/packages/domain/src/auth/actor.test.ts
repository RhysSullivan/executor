import { describe, expect, it } from "@effect/vitest";
import {
  OrganizationMembershipSchema,
  PrincipalSchema,
  WorkspaceMembershipSchema,
  type OrganizationMembership,
  type Principal,
  type WorkspaceMembership,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import { makeActor } from "./actor";

const decodePrincipal = Schema.decodeUnknownSync(PrincipalSchema);
const decodeWorkspaceMembership = Schema.decodeUnknownSync(WorkspaceMembershipSchema);
const decodeOrganizationMembership = Schema.decodeUnknownSync(
  OrganizationMembershipSchema,
);

const principal = decodePrincipal({
  accountId: "acct_local",
  provider: "local",
  subject: "local:acct_local",
  email: "dev@example.com",
  displayName: "Dev User",
}) satisfies Principal;

const workspaceMembership = decodeWorkspaceMembership({
  accountId: "acct_local",
  workspaceId: "ws_local",
  role: "editor",
  status: "active",
  grantedAt: 1,
  updatedAt: 1,
}) satisfies WorkspaceMembership;

const organizationMembership = decodeOrganizationMembership({
  id: "orgmem_1",
  organizationId: "org_local",
  accountId: "acct_local",
  role: "viewer",
  status: "active",
  billable: true,
  invitedByAccountId: null,
  joinedAt: 1,
  createdAt: 1,
  updatedAt: 1,
}) satisfies OrganizationMembership;

describe("makeActor", () => {
  it.effect("fails when principal is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        makeActor({
          principal: null,
          workspaceMemberships: [],
          organizationMemberships: [],
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ActorUnauthenticatedError");
      }
    }),
  );

  it.effect("evaluates workspace-scoped permission checks", () =>
    Effect.gen(function* () {
      const actor = yield* makeActor({
        principal,
        workspaceMemberships: [workspaceMembership],
        organizationMemberships: [],
      });

      expect(
        actor.hasPermission({
          permission: "sources:write",
          workspaceId: workspaceMembership.workspaceId,
        }),
      ).toBe(true);

      expect(
        actor.hasPermission({
          permission: "sources:manage",
          workspaceId: workspaceMembership.workspaceId,
        }),
      ).toBe(false);
    }),
  );

  it.effect("evaluates organization-scoped permission checks", () =>
    Effect.gen(function* () {
      const actor = yield* makeActor({
        principal,
        workspaceMemberships: [],
        organizationMemberships: [organizationMembership],
      });

      expect(
        actor.hasPermission({
          permission: "organizations:read",
          organizationId: organizationMembership.organizationId,
        }),
      ).toBe(true);

      expect(
        actor.hasPermission({
          permission: "organizations:manage",
          organizationId: organizationMembership.organizationId,
        }),
      ).toBe(false);
    }),
  );

  it.effect("returns forbidden error for denied required permission", () =>
    Effect.gen(function* () {
      const actor = yield* makeActor({
        principal,
        workspaceMemberships: [workspaceMembership],
        organizationMemberships: [],
      });

      const result = yield* Effect.either(
        actor.requirePermission({
          permission: "sources:manage",
          workspaceId: workspaceMembership.workspaceId,
        }),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ActorForbiddenError");
        expect(result.left.permission).toBe("sources:manage");
      }
    }),
  );
});
