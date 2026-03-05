import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeSqlControlPlanePersistence } from "./index";

const makePersistence = Effect.acquireRelease(
  makeSqlControlPlanePersistence({
    localDataDir: ":memory:",
  }),
  (persistence) =>
    Effect.tryPromise({
      try: () => persistence.close(),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.orDie),
);

describe("control-plane-persistence-drizzle", () => {
  it.scoped("creates and reads organization/workspace/source/policy rows", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();

      yield* persistence.rows.organizations.insert({
        id: "org_1" as never,
        slug: "acme",
        name: "Acme",
        status: "active",
        createdByAccountId: "acc_1" as never,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.workspaces.insert({
        id: "ws_1" as never,
        organizationId: "org_1" as never,
        name: "Main",
        createdByAccountId: "acc_1" as never,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.sources.insert({
        id: "src_1" as never,
        workspaceId: "ws_1" as never,
        name: "Github",
        kind: "openapi",
        endpoint: "https://api.github.com/openapi.json",
        status: "draft",
        enabled: true,
        configJson: "{}",
        sourceHash: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.policies.insert({
        id: "pol_1" as never,
        workspaceId: "ws_1" as never,
        targetAccountId: null,
        clientId: null,
        resourceType: "tool_path",
        resourcePattern: "source.github.*",
        matchType: "glob",
        effect: "allow",
        approvalMode: "auto",
        argumentConditionsJson: null,
        priority: 10,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });

      const workspace = yield* persistence.rows.workspaces.getById("ws_1" as never);
      expect(Option.isSome(workspace)).toBe(true);

      const sources = yield* persistence.rows.sources.listByWorkspaceId("ws_1" as never);
      expect(sources).toHaveLength(1);
      expect(sources[0]?.name).toBe("Github");

      const policies = yield* persistence.rows.policies.listByWorkspaceId("ws_1" as never);
      expect(policies).toHaveLength(1);
      expect(policies[0]?.resourcePattern).toBe("source.github.*");
    }),
  );

  it.scoped("upserts organization memberships by org/account", () =>
    Effect.gen(function* () {
      const persistence = yield* makePersistence;
      const now = Date.now();

      yield* persistence.rows.organizationMemberships.upsert({
        id: "mem_1" as never,
        organizationId: "org_1" as never,
        accountId: "acc_1" as never,
        role: "viewer",
        status: "active",
        billable: true,
        invitedByAccountId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      yield* persistence.rows.organizationMemberships.upsert({
        id: "mem_2" as never,
        organizationId: "org_1" as never,
        accountId: "acc_1" as never,
        role: "admin",
        status: "active",
        billable: true,
        invitedByAccountId: null,
        joinedAt: now,
        createdAt: now,
        updatedAt: now + 1,
      });

      const membership = yield* persistence.rows.organizationMemberships.getByOrganizationAndAccount(
        "org_1" as never,
        "acc_1" as never,
      );

      expect(Option.isSome(membership)).toBe(true);
      if (Option.isSome(membership)) {
        expect(membership.value.role).toBe("admin");
      }
    }),
  );

});
