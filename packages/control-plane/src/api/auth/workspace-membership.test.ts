import { describe, expect, it } from "@effect/vitest";

import { deriveWorkspaceMembershipsForPrincipal } from "./workspace-membership";

describe("workspace membership derivation", () => {
  it("prefers highest active role in matching organization", () => {
    const memberships = deriveWorkspaceMembershipsForPrincipal({
      principalAccountId: "acc_1" as never,
      workspaceId: "ws_1" as never,
      workspace: {
        id: "ws_1" as never,
        organizationId: "org_1" as never,
        name: "Main",
        createdByAccountId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      organizationMemberships: [
        {
          id: "mem_1" as never,
          organizationId: "org_1" as never,
          accountId: "acc_1" as never,
          role: "viewer",
          status: "active",
          billable: true,
          invitedByAccountId: null,
          joinedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "mem_2" as never,
          organizationId: "org_1" as never,
          accountId: "acc_1" as never,
          role: "admin",
          status: "active",
          billable: true,
          invitedByAccountId: null,
          joinedAt: 2,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });

    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("admin");
  });
});
