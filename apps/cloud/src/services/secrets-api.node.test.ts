// Secrets endpoints — set / list / status / resolve / remove round-trip
// and error fidelity within a single org.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ScopeId, SecretId } from "@executor/sdk";

import { asOrg } from "./__test-harness__/api-harness";

describe("secrets api (HTTP)", () => {
  it.effect("set → list → resolve round-trips a new secret", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const id = `sec_${crypto.randomUUID().slice(0, 8)}`;

      const setRef = yield* asOrg(org, (client) =>
        client.secrets.set({
          path: { scopeId: ScopeId.make(org) },
          payload: { id: SecretId.make(id), name: "My API Token", value: "sk-test-abc" },
        }),
      );
      expect(setRef.id).toBe(id);
      expect(setRef.scopeId).toBe(org);

      const list = yield* asOrg(org, (client) =>
        client.secrets.list({ path: { scopeId: ScopeId.make(org) } }),
      );
      expect(list.find((s) => s.id === id)?.name).toBe("My API Token");

      const resolved = yield* asOrg(org, (client) =>
        client.secrets.resolve({
          path: { scopeId: ScopeId.make(org), secretId: SecretId.make(id) },
        }),
      );
      expect(resolved.value).toBe("sk-test-abc");
    }),
  );

  it.effect("status is resolved for an existing secret, missing for an unknown id", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const id = `sec_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(org, (client) =>
        client.secrets.set({
          path: { scopeId: ScopeId.make(org) },
          payload: { id: SecretId.make(id), name: "n", value: "v" },
        }),
      );

      const resolvedStatus = yield* asOrg(org, (client) =>
        client.secrets.status({
          path: { scopeId: ScopeId.make(org), secretId: SecretId.make(id) },
        }),
      );
      expect(resolvedStatus.status).toBe("resolved");

      const missingStatus = yield* asOrg(org, (client) =>
        client.secrets.status({
          path: {
            scopeId: ScopeId.make(org),
            secretId: SecretId.make(`missing_${crypto.randomUUID().slice(0, 8)}`),
          },
        }),
      );
      expect(missingStatus.status).toBe("missing");
    }),
  );

  it.effect("remove deletes the secret; subsequent resolve fails and list drops it", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const id = `sec_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            path: { scopeId: ScopeId.make(org) },
            payload: { id: SecretId.make(id), name: "n", value: "v" },
          });
          yield* client.secrets.remove({
            path: { scopeId: ScopeId.make(org), secretId: SecretId.make(id) },
          });
        }),
      );

      const list = yield* asOrg(org, (client) =>
        client.secrets.list({ path: { scopeId: ScopeId.make(org) } }),
      );
      expect(list.map((s) => s.id)).not.toContain(id);

      const afterResolve = yield* asOrg(org, (client) =>
        client.secrets
          .resolve({ path: { scopeId: ScopeId.make(org), secretId: SecretId.make(id) } })
          .pipe(Effect.either),
      );
      expect(afterResolve._tag).toBe("Left");
    }),
  );

  it.effect("resolve on an unknown id fails with a typed error", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const missing = `missing_${crypto.randomUUID().slice(0, 8)}`;

      const result = yield* asOrg(org, (client) =>
        client.secrets
          .resolve({ path: { scopeId: ScopeId.make(org), secretId: SecretId.make(missing) } })
          .pipe(Effect.either),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        // The API declares SecretNotFoundError / SecretResolutionError
        // as typed errors; either is acceptable for an unknown id.
        const err = result.left as { _tag?: string };
        expect(
          err._tag === "SecretNotFoundError" || err._tag === "SecretResolutionError",
        ).toBe(true);
      }
    }),
  );

  it.effect("remove on an unknown id is a no-op (idempotent)", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const missing = `missing_${crypto.randomUUID().slice(0, 8)}`;

      const result = yield* asOrg(org, (client) =>
        client.secrets
          .remove({ path: { scopeId: ScopeId.make(org), secretId: SecretId.make(missing) } })
          .pipe(Effect.either),
      );
      expect(result._tag).toBe("Right");
    }),
  );

  it.effect("set with the same id twice updates the value (upsert)", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const id = `sec_${crypto.randomUUID().slice(0, 8)}`;

      const first = yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            path: { scopeId: ScopeId.make(org) },
            payload: { id: SecretId.make(id), name: "first", value: "first-value" },
          });
          return yield* client.secrets.resolve({
            path: { scopeId: ScopeId.make(org), secretId: SecretId.make(id) },
          });
        }),
      );
      expect(first.value).toBe("first-value");

      const second = yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            path: { scopeId: ScopeId.make(org) },
            payload: { id: SecretId.make(id), name: "updated", value: "second-value" },
          });
          return yield* client.secrets.resolve({
            path: { scopeId: ScopeId.make(org), secretId: SecretId.make(id) },
          });
        }),
      );
      expect(second.value).toBe("second-value");
    }),
  );
});
