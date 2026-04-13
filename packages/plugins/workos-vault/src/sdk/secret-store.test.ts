import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { ScopeId, SecretId, makeInMemoryScopedKv } from "@executor/sdk";

import {
  WORKOS_VAULT_PROVIDER_KEY,
  makeWorkOSVaultSecretStore,
} from "./secret-store";
import {
  WorkOSVaultClient,
  WorkOSVaultClientError,
} from "./client";
import type {
  WorkOSVaultObject,
  WorkOSVaultObjectMetadata,
} from "./client";

class FakeNotFoundError extends Error {
  readonly status = 404;
}

class FakeConflictError extends Error {
  readonly status = 409;
}

const makeMetadata = (id: string, context: Record<string, string>): WorkOSVaultObjectMetadata => ({
  id,
  context,
  updatedAt: new Date(),
  versionId: `${id}-v1`,
});

const makeFakeClient = (
  options?: { readonly conflictOnNextSecretUpdate?: boolean },
): WorkOSVaultClient => {
  const objects = new Map<string, WorkOSVaultObject>();
  let sequence = 0;
  let conflictOnNextSecretUpdate = options?.conflictOnNextSecretUpdate ?? false;

  const nextId = () => `obj_${sequence += 1}`;
  const wrap = <A>(
    operation: string,
    fn: () => Promise<A>,
  ): Effect.Effect<A, WorkOSVaultClientError, never> =>
    Effect.tryPromise({
      try: fn,
      catch: (cause) => new WorkOSVaultClientError({ cause, operation }),
    });

  const rawClient = {
    createObject: async ({
      name,
      value,
      context,
    }: {
      readonly name: string;
      readonly value: string;
      readonly context: Record<string, string>;
    }) => {
      if (objects.has(name)) {
        throw new FakeConflictError(`Object "${name}" already exists`);
      }

      const id = nextId();
      const metadata = makeMetadata(id, context);
      objects.set(name, { id, name, value, metadata });
      return metadata;
    },

    readObjectByName: async (name: string) => {
      const object = objects.get(name);
      if (!object) throw new FakeNotFoundError(`Object "${name}" not found`);
      return object;
    },

    updateObject: async ({
      id,
      value,
      versionCheck,
    }: {
      readonly id: string;
      readonly value: string;
      readonly versionCheck?: string;
    }) => {
      const current = [...objects.values()].find((object) => object.id === id);
      if (!current) throw new FakeNotFoundError(`Object "${id}" not found`);
      if (versionCheck && current.metadata.versionId !== versionCheck) {
        throw new FakeConflictError(`Version mismatch for "${id}"`);
      }
      if (conflictOnNextSecretUpdate && current.name.endsWith("/secrets/conflict")) {
        conflictOnNextSecretUpdate = false;
        throw new FakeConflictError(`Injected conflict for "${id}"`);
      }

      const nextVersion = current.metadata.versionId.replace(/v(\d+)$/, (_, version) => {
        return `v${Number(version) + 1}`;
      });
      const next: WorkOSVaultObject = {
        ...current,
        value,
        metadata: {
          ...current.metadata,
          updatedAt: new Date(),
          versionId: nextVersion,
        },
      };
      objects.set(current.name, next);
      return next;
    },

    deleteObject: async ({ id }: { readonly id: string }) => {
      const current = [...objects.entries()].find(([, object]) => object.id === id);
      if (!current) throw new FakeNotFoundError(`Object "${id}" not found`);
      objects.delete(current[0]);
    },
  };

  return {
    use: (operation, fn) =>
      Effect.tryPromise({
        try: () => fn(rawClient),
        catch: (cause) => new WorkOSVaultClientError({ cause, operation }),
      }),
    createObject: (options) => wrap("create_object", () => rawClient.createObject(options)),
    readObjectByName: (name) => wrap("read_object_by_name", () => rawClient.readObjectByName(name)),
    updateObject: (options) => wrap("update_object", () => rawClient.updateObject(options)),
    deleteObject: (options) => wrap("delete_object", () => rawClient.deleteObject(options)),
  };
};

const makeStore = (client: WorkOSVaultClient) =>
  makeWorkOSVaultSecretStore({
    client,
    metadataStore: makeInMemoryScopedKv(),
    scopeId: "org_123",
  });

describe("WorkOS Vault secret store", () => {
  it.effect("stores and resolves secrets from WorkOS Vault", () =>
    Effect.gen(function* () {
      const store = makeStore(makeFakeClient());

      const ref = yield* store.set({
        id: SecretId.make("github-token"),
        scopeId: ScopeId.make("org_123"),
        name: "GitHub Token",
        value: "ghp_secret",
        purpose: "GitHub API auth",
      });

      expect(Option.getOrUndefined(ref.provider)).toBe(WORKOS_VAULT_PROVIDER_KEY);
      expect(yield* store.resolve(SecretId.make("github-token"), ScopeId.make("org_123"))).toBe(
        "ghp_secret",
      );

      const listed = yield* store.list(ScopeId.make("org_123"));
      expect(listed).toHaveLength(1);
      expect(listed[0]!.name).toBe("GitHub Token");
    }),
  );

  it.effect("updates metadata and secret values in place", () =>
    Effect.gen(function* () {
      const store = makeStore(makeFakeClient());

      yield* store.set({
        id: SecretId.make("api-key"),
        scopeId: ScopeId.make("org_123"),
        name: "Initial",
        value: "v1",
      });

      const updated = yield* store.set({
        id: SecretId.make("api-key"),
        scopeId: ScopeId.make("org_123"),
        name: "Updated",
        value: "v2",
        purpose: "rotated",
      });

      expect(updated.name).toBe("Updated");
      expect(updated.purpose).toBe("rotated");
      expect(yield* store.resolve(SecretId.make("api-key"), ScopeId.make("org_123"))).toBe("v2");
    }),
  );

  it.effect("removes secrets and reports missing status", () =>
    Effect.gen(function* () {
      const store = makeStore(makeFakeClient());

      yield* store.set({
        id: SecretId.make("remove-me"),
        scopeId: ScopeId.make("org_123"),
        name: "Remove Me",
        value: "gone soon",
      });

      expect(yield* store.status(SecretId.make("remove-me"), ScopeId.make("org_123"))).toBe(
        "resolved",
      );
      expect(yield* store.remove(SecretId.make("remove-me"))).toBe(true);
      expect(yield* store.status(SecretId.make("remove-me"), ScopeId.make("org_123"))).toBe(
        "missing",
      );
    }),
  );

  it.effect("retries secret value writes on version conflicts", () =>
    Effect.gen(function* () {
      const store = makeStore(makeFakeClient({ conflictOnNextSecretUpdate: true }));

      yield* store.set({
        id: SecretId.make("conflict"),
        scopeId: ScopeId.make("org_123"),
        name: "Conflict",
        value: "retry-me",
      });

      const listed = yield* store.list(ScopeId.make("org_123"));
      expect(listed.map((secret) => secret.id)).toEqual(["conflict"]);
    }),
  );
});
