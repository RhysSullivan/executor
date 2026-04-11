import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { SecretId, ScopeId } from "../ids";
import type { SecretStore, SecretRow } from "../stores/secret-store";

export interface SecretStoreContractConfig {
  readonly makeStore: () => Effect.Effect<{
    readonly store: SecretStore;
    readonly teardown: Effect.Effect<void>;
  }>;
}

const makeRow = (id: string, scopeId: string, overrides?: Partial<SecretRow>): SecretRow => ({
  id,
  scopeId,
  name: `secret-${id}`,
  purpose: null,
  provider: "storage-encrypted",
  encryptedValue: null,
  iv: null,
  createdAt: new Date("2024-01-01"),
  ...overrides,
});

export const createSecretStoreContract = (
  name: string,
  config: SecretStoreContractConfig,
): void => {
  describe(`${name} SecretStore contract`, () => {
    it.effect("upsert then findById returns the row with all fields", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          const row = makeRow("s1", "scope-1", { purpose: "my-purpose" });
          yield* store.upsert(row);
          const found = yield* store.findById(SecretId.make("s1"), ScopeId.make("scope-1"));
          expect(found?.id).toBe("s1");
          expect(found?.name).toBe("secret-s1");
          expect(found?.purpose).toBe("my-purpose");
          expect(found?.provider).toBe("storage-encrypted");
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("upsert replaces existing row", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(makeRow("s2", "scope-1"));
          yield* store.upsert(makeRow("s2", "scope-1", { name: "updated-name" }));
          const found = yield* store.findById(SecretId.make("s2"), ScopeId.make("scope-1"));
          expect(found?.name).toBe("updated-name");
          const all = yield* store.findByScope(ScopeId.make("scope-1"));
          expect(all.length).toBe(1);
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("findByScope returns only secrets in that scope", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(makeRow("s3a", "scope-a"));
          yield* store.upsert(makeRow("s3b", "scope-a"));
          yield* store.upsert(makeRow("s3c", "scope-b"));
          const scopeA = yield* store.findByScope(ScopeId.make("scope-a"));
          expect(scopeA.length).toBe(2);
          const ids = scopeA.map((r) => r.id).sort();
          expect(ids).toEqual(["s3a", "s3b"]);
        } finally {
          yield* teardown;
        }
      }),
    );

    it.effect("deleteById removes the row and returns true; missing id returns false", () =>
      Effect.gen(function* () {
        const { store, teardown } = yield* config.makeStore();
        try {
          yield* store.upsert(makeRow("s4", "scope-1"));
          const deleted = yield* store.deleteById(SecretId.make("s4"), ScopeId.make("scope-1"));
          expect(deleted).toBe(true);
          const found = yield* store.findById(SecretId.make("s4"), ScopeId.make("scope-1"));
          expect(found).toBeNull();
          const deletedAgain = yield* store.deleteById(
            SecretId.make("s4"),
            ScopeId.make("scope-1"),
          );
          expect(deletedAgain).toBe(false);
        } finally {
          yield* teardown;
        }
      }),
    );
  });
};
