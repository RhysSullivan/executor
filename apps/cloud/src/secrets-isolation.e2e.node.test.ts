// End-to-end coverage for secret isolation *through the real HTTP API*.
//
// Complements tenant-isolation.node.test.ts (which already covers plain
// cross-org isolation at the org scope) by exercising the two-scope stack
// the cloud app actually ships: `[userOrgScope, orgScope]`. The harness
// builds the same shape `apps/cloud/src/services/executor.ts#createScopedExecutor`
// builds in production, and every request goes through `HttpApiClient` →
// `fetch` → the real `ProtectedCloudApi` → real postgres adapter.
//
// Invariants the product is staking on:
//
//   1. Users in different orgs can't see each other's secrets — not even
//      secrets written at the org scope of the other org.
//   2. Users in the same org can't see each other's user-scoped secrets
//      (per-user OAuth tokens etc. don't leak to co-workers).
//   3. Org-scoped secrets ARE visible to every user in that org — an
//      admin writing a shared API key serves the whole tenant.
//   4. The same user id in different orgs gets distinct per-user scopes —
//      the userOrgScope id bakes in the org id on purpose.
//   5. secrets.set rejects a scope id outside the caller's executor stack.
//
// NOTE: "per-user override shadows org default" cross-scope co-existence
// is NOT covered here. `executor.secrets.set` currently deletes secret
// metadata rows across the full scope stack before re-inserting at the
// target scope (see executor.ts `secretsSet`), so an overrider writing
// at their user-org scope wipes the org-level default rather than
// shadowing it. If the product wants both rows to coexist, that's an
// SDK-level change — coverage for it belongs after the fix.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ScopeId, SecretId } from "@executor/sdk";

import {
  asUser,
  testUserOrgScopeId,
} from "./services/__test-harness__/api-harness";

const uniq = () => crypto.randomUUID().slice(0, 8);
const nextOrgId = () => `org_iso_${uniq()}`;
const nextUserId = () => `user_iso_${uniq()}`;

describe("cloud secret isolation (HTTP, user-org scope stack)", () => {
  it.effect(
    "users in different orgs cannot read each other's org-scoped secrets",
    () =>
      Effect.gen(function* () {
        const orgA = nextOrgId();
        const orgB = nextOrgId();
        const alice = nextUserId();
        const charlie = nextUserId();
        const id = `sec_${uniq()}`;

        yield* asUser(alice, orgA, (client) =>
          client.secrets.set({
            path: { scopeId: ScopeId.make(orgA) },
            payload: {
              id: SecretId.make(id),
              name: "Shared",
              value: "alice-org-secret",
            },
          }),
        );

        const charlieStatus = yield* asUser(charlie, orgB, (client) =>
          client.secrets.status({
            path: { scopeId: ScopeId.make(orgB), secretId: SecretId.make(id) },
          }),
        );
        expect(charlieStatus.status).toBe("missing");

        const charlieList = yield* asUser(charlie, orgB, (client) =>
          client.secrets.list({ path: { scopeId: ScopeId.make(orgB) } }),
        );
        expect(charlieList.map((s) => s.id)).not.toContain(id);

        const charlieResolve = yield* asUser(charlie, orgB, (client) =>
          client.secrets
            .resolve({
              path: { scopeId: ScopeId.make(orgB), secretId: SecretId.make(id) },
            })
            .pipe(Effect.either),
        );
        expect(charlieResolve._tag).toBe("Left");
      }),
  );

  it.effect(
    "users in same org cannot read each other's user-scoped secrets",
    () =>
      Effect.gen(function* () {
        const orgId = nextOrgId();
        const aliceId = nextUserId();
        const bobId = nextUserId();
        const id = `sec_${uniq()}`;

        // Alice writes at her per-user scope — where OAuth tokens land.
        yield* asUser(aliceId, orgId, (client) =>
          client.secrets.set({
            path: { scopeId: ScopeId.make(testUserOrgScopeId(aliceId, orgId)) },
            payload: {
              id: SecretId.make(id),
              name: "Alice's token",
              value: "alice-token-value",
            },
          }),
        );

        // Bob is in the same org — his user-org scope differs. He should
        // see neither the token in a list nor be able to resolve it.
        const bobList = yield* asUser(bobId, orgId, (client) =>
          client.secrets.list({
            path: { scopeId: ScopeId.make(testUserOrgScopeId(bobId, orgId)) },
          }),
        );
        expect(bobList.map((s) => s.id)).not.toContain(id);

        const bobResolve = yield* asUser(bobId, orgId, (client) =>
          client.secrets
            .resolve({
              path: {
                scopeId: ScopeId.make(testUserOrgScopeId(bobId, orgId)),
                secretId: SecretId.make(id),
              },
            })
            .pipe(Effect.either),
        );
        expect(bobResolve._tag).toBe("Left");

        // And Alice still sees her own token.
        const aliceResolve = yield* asUser(aliceId, orgId, (client) =>
          client.secrets.resolve({
            path: {
              scopeId: ScopeId.make(testUserOrgScopeId(aliceId, orgId)),
              secretId: SecretId.make(id),
            },
          }),
        );
        expect(aliceResolve.value).toBe("alice-token-value");
      }),
  );

  it.effect(
    "org-scoped secrets are visible to every user in that org",
    () =>
      Effect.gen(function* () {
        const orgId = nextOrgId();
        const adminId = nextUserId();
        const memberId = nextUserId();
        const id = `sec_${uniq()}`;

        yield* asUser(adminId, orgId, (client) =>
          client.secrets.set({
            path: { scopeId: ScopeId.make(orgId) },
            payload: {
              id: SecretId.make(id),
              name: "Org API Key",
              value: "shared-org-key",
            },
          }),
        );

        const adminValue = yield* asUser(adminId, orgId, (client) =>
          client.secrets.resolve({
            path: { scopeId: ScopeId.make(orgId), secretId: SecretId.make(id) },
          }),
        );
        const memberValue = yield* asUser(memberId, orgId, (client) =>
          client.secrets.resolve({
            path: { scopeId: ScopeId.make(orgId), secretId: SecretId.make(id) },
          }),
        );
        expect(adminValue.value).toBe("shared-org-key");
        expect(memberValue.value).toBe("shared-org-key");
      }),
  );

  it.effect(
    "same userId in different orgs gets distinct per-user scopes",
    () =>
      Effect.gen(function* () {
        const userId = nextUserId();
        const orgA = nextOrgId();
        const orgB = nextOrgId();
        const id = `sec_${uniq()}`;

        yield* asUser(userId, orgA, (client) =>
          client.secrets.set({
            path: { scopeId: ScopeId.make(testUserOrgScopeId(userId, orgA)) },
            payload: {
              id: SecretId.make(id),
              name: "A token",
              value: "value-in-a",
            },
          }),
        );

        // Same user id, different org → distinct user-org scope. The
        // secret written in org A must not be visible when the same user
        // logs into org B.
        const listInB = yield* asUser(userId, orgB, (client) =>
          client.secrets.list({
            path: { scopeId: ScopeId.make(testUserOrgScopeId(userId, orgB)) },
          }),
        );
        expect(listInB.map((s) => s.id)).not.toContain(id);

        const resolveInB = yield* asUser(userId, orgB, (client) =>
          client.secrets
            .resolve({
              path: {
                scopeId: ScopeId.make(testUserOrgScopeId(userId, orgB)),
                secretId: SecretId.make(id),
              },
            })
            .pipe(Effect.either),
        );
        expect(resolveInB._tag).toBe("Left");

        // Sanity: the original write is still readable under the org-A
        // user-org scope.
        const resolveInA = yield* asUser(userId, orgA, (client) =>
          client.secrets.resolve({
            path: {
              scopeId: ScopeId.make(testUserOrgScopeId(userId, orgA)),
              secretId: SecretId.make(id),
            },
          }),
        );
        expect(resolveInA.value).toBe("value-in-a");
      }),
  );

  it.effect("secrets.set rejects a scope outside the executor's stack", () =>
    Effect.gen(function* () {
      const orgId = nextOrgId();
      const userId = nextUserId();
      const foreignOrg = nextOrgId();

      const result = yield* asUser(userId, orgId, (client) =>
        client.secrets
          .set({
            path: { scopeId: ScopeId.make(foreignOrg) },
            payload: {
              id: SecretId.make("wrong-scope"),
              name: "x",
              value: "should not land",
            },
          })
          .pipe(Effect.either),
      );
      expect(result._tag).toBe("Left");

      // And nothing landed in the foreign org — a fresh session pointed
      // at that org must not see `wrong-scope`.
      const foreignUser = nextUserId();
      const leaked = yield* asUser(foreignUser, foreignOrg, (client) =>
        client.secrets
          .resolve({
            path: {
              scopeId: ScopeId.make(foreignOrg),
              secretId: SecretId.make("wrong-scope"),
            },
          })
          .pipe(Effect.either),
      );
      expect(leaked._tag).toBe("Left");
    }),
  );
});
