// Cross-target: the full policies CRUD round-trip through the typed
// HttpApiClient. The existing `policies.test.ts` scenario pins create + list
// only, the gaps this scenario closes are `update` (both full-payload and
// action-only partial, the shape the row badge's `handleUpdate` sends) and
// `remove`. Asserts on:
//
//   1. The create response carries a non-empty `position` (the fractional-
//      indexing key the policies page's sort and reorder math both depend
//      on, a regression that drops it would silently break ordering).
//   2. A full update returns the new pattern + action; a subsequent partial
//      update (action only, no pattern in the payload) flips the action and
//      leaves the pattern intact.
//   3. The list reflects the latest server-side values between writes.
//   4. After remove, list returns success and does NOT contain the id,
//      asserted as `expect(ids).not.toContain(created.id)` so a regression
//      prints the leaked ids instead of `false`.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

scenario(
  "Policies · an existing policy can be re-targeted, partially edited, and removed",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* apiClient(coreApi, identity);

    // Selfhost shares one bootstrap-admin workspace across scenarios, so
    // every pattern carries a per-run suffix and the finalizer removes any
    // row carrying it, even if a mid-test failure skips the explicit remove.
    const suffix = randomBytes(4).toString("hex");
    const prefix = `policies-lc-${suffix}.`;
    const initialPattern = `${prefix}alpha`;
    const renamedPattern = `${prefix}beta`;

    const cleanup = Effect.gen(function* () {
      const policies = yield* client.policies.list().pipe(Effect.orElseSucceed(() => []));
      yield* Effect.forEach(
        policies.filter((p) => p.pattern.startsWith(prefix)),
        (p) =>
          client.policies
            .remove({ params: { policyId: p.id }, payload: { owner: p.owner } })
            .pipe(Effect.ignore),
      );
    }).pipe(Effect.ignore);

    yield* Effect.gen(function* () {
      const created = yield* client.policies.create({
        payload: { owner: "org", pattern: initialPattern, action: "block" },
      });
      expect(created.pattern, "create response echoes the requested pattern").toBe(initialPattern);
      expect(created.action, "create response echoes the requested action").toBe("block");
      // The page's sort and reorder math both depend on a non-empty position;
      // a regression that ever leaves it blank would silently break ordering
      // without raising on any single create.
      expect(created.position, "create response carries a fractional-indexing key").not.toBe("");

      // Full payload: pattern AND action change in one update, the path the
      // page itself never sends today, but `policies.update` advertises.
      const renamed = yield* client.policies.update({
        params: { policyId: created.id },
        payload: { owner: "org", pattern: renamedPattern, action: "approve" },
      });
      expect(renamed.pattern, "full update applied the new pattern").toBe(renamedPattern);
      expect(renamed.action, "full update applied the new action").toBe("approve");

      // Partial payload: action only, no pattern, the exact shape the row
      // badge's `handleUpdate` sends. The server should flip the action and
      // leave the pattern intact.
      const switched = yield* client.policies.update({
        params: { policyId: created.id },
        payload: { owner: "org", action: "require_approval" },
      });
      expect(switched.action, "partial update flipped the action").toBe("require_approval");
      expect(switched.pattern, "partial update preserved the pattern").toBe(renamedPattern);

      // List reflects the latest values between writes.
      const afterEdit = yield* client.policies.list();
      const myEntry = afterEdit.find((p) => p.id === created.id);
      expect(myEntry, "the edited row appears in list with the latest values").toMatchObject({
        pattern: renamedPattern,
        action: "require_approval",
      });

      yield* client.policies.remove({
        params: { policyId: created.id },
        payload: { owner: "org" },
      });

      const afterRemove = yield* client.policies.list();
      expect(
        afterRemove.map((p) => p.id),
        "the removed id is gone from the list",
      ).not.toContain(created.id);
    }).pipe(Effect.ensuring(cleanup));
  }),
);
