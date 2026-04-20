import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createExecutor,
  makeTestConfig,
  ScopeId,
  SecretId,
  SetSecretInput,
} from "@executor/sdk";

import {
  WorkOSVaultClientError,
  type WorkOSVaultClient,
  type WorkOSVaultObject,
  type WorkOSVaultObjectMetadata,
} from "./client";
import { workosVaultPlugin } from "./plugin";

// ---------------------------------------------------------------------------
// Fake status errors — the real provider's isStatusError check pattern-
// matches on a `status` field, so these bare Error subclasses are
// enough to simulate 404/409 responses from the WorkOS SDK.
// ---------------------------------------------------------------------------

class FakeNotFoundError extends Error {
  readonly status = 404;
}

class FakeConflictError extends Error {
  readonly status = 409;
}

const makeMetadata = (
  id: string,
  context: Record<string, string>,
  versionId: string = `${id}-v1`,
): WorkOSVaultObjectMetadata => ({
  id,
  context,
  updatedAt: new Date(),
  versionId,
});

// ---------------------------------------------------------------------------
// makeFakeClient — in-memory WorkOS Vault mock.
//
// `conflictOnNextSecretUpdate` injects a single 409 on the next
// `updateObject` call against an object whose name ends in
// `/secrets/conflict`. After consuming the conflict it behaves
// normally, so the retry loop's second attempt re-reads the current
// version and succeeds.
// ---------------------------------------------------------------------------

const makeFakeClient = (options?: {
  readonly conflictOnNextSecretUpdate?: boolean;
}): WorkOSVaultClient => {
  const objects = new Map<string, WorkOSVaultObject>();
  let sequence = 0;
  let conflictPending = options?.conflictOnNextSecretUpdate ?? false;

  const nextId = () => `obj_${(sequence += 1)}`;

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
      const current = [...objects.values()].find((o) => o.id === id);
      if (!current) throw new FakeNotFoundError(`Object "${id}" not found`);
      if (
        conflictPending &&
        current.name.endsWith("/secrets/conflict")
      ) {
        conflictPending = false;
        throw new FakeConflictError(`Injected conflict for "${id}"`);
      }
      if (versionCheck && current.metadata.versionId !== versionCheck) {
        throw new FakeConflictError(`Version mismatch for "${id}"`);
      }
      const nextVersion = current.metadata.versionId.replace(
        /v(\d+)$/,
        (_, version) => `v${Number(version) + 1}`,
      );
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
      const entry = [...objects.entries()].find(([, o]) => o.id === id);
      if (!entry) throw new FakeNotFoundError(`Object "${id}" not found`);
      objects.delete(entry[0]);
    },
  };

  return {
    use: (operation, fn) =>
      Effect.tryPromise({
        try: () => fn(rawClient),
        catch: (cause) => new WorkOSVaultClientError({ cause, operation }),
      }),
    createObject: (opts) =>
      wrap("create_object", () => rawClient.createObject(opts)),
    readObjectByName: (name) =>
      wrap("read_object_by_name", () => rawClient.readObjectByName(name)),
    updateObject: (opts) =>
      wrap("update_object", () => rawClient.updateObject(opts)),
    deleteObject: (opts) =>
      wrap("delete_object", () => rawClient.deleteObject(opts)),
  };
};

const makeExecutor = (client: WorkOSVaultClient) =>
  createExecutor(
    makeTestConfig({ plugins: [workosVaultPlugin({ client })] as const }),
  );

// ---------------------------------------------------------------------------
// Tests — drive the provider through the real executor's secrets facade
// so we exercise the core `secret` routing table + metadata-store + Vault
// roundtrip all at once.
// ---------------------------------------------------------------------------

describe("WorkOS Vault secret provider", () => {
  it.effect("stores and resolves secrets through WorkOS Vault", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor(makeFakeClient());

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("github-token"),
          scope: ScopeId.make("test-scope"),
          name: "GitHub Token",
          value: "ghp_secret",
        }),
      );

      expect(yield* executor.secrets.get("github-token")).toBe("ghp_secret");
      expect(executor.workosVault.providerKey).toBe("workos-vault");

      const listed = yield* executor.secrets.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.name).toBe("GitHub Token");
      expect(listed[0]!.provider).toBe("workos-vault");
    }),
  );

  it.effect("updates metadata and secret values in place", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor(makeFakeClient());

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("api-key"),
          scope: ScopeId.make("test-scope"),
          name: "Initial",
          value: "v1",
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("api-key"),
          scope: ScopeId.make("test-scope"),
          name: "Updated",
          value: "v2",
        }),
      );

      expect(yield* executor.secrets.get("api-key")).toBe("v2");

      const listed = yield* executor.secrets.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.name).toBe("Updated");
    }),
  );

  it.effect("removes secrets from Vault and metadata store", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor(makeFakeClient());

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("remove-me"),
          scope: ScopeId.make("test-scope"),
          name: "Remove Me",
          value: "gone soon",
        }),
      );

      expect(yield* executor.secrets.get("remove-me")).toBe("gone soon");

      yield* executor.secrets.remove("remove-me");

      expect(yield* executor.secrets.get("remove-me")).toBeNull();
      expect(yield* executor.secrets.list()).toHaveLength(0);
    }),
  );

  it.effect("retries secret value writes on 409 version conflicts", () =>
    Effect.gen(function* () {
      // Inject one conflict on the next update against `/secrets/conflict`.
      // Flow: first `set` creates the object (no update). Second `set`
      // takes the update path and hits the injected conflict; the retry
      // loop re-reads and succeeds on the second attempt.
      const executor = yield* makeExecutor(
        makeFakeClient({ conflictOnNextSecretUpdate: true }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("conflict"),
          scope: ScopeId.make("test-scope"),
          name: "Conflict",
          value: "initial",
        }),
      );

      yield* executor.secrets.set(
        new SetSecretInput({
          id: SecretId.make("conflict"),
          scope: ScopeId.make("test-scope"),
          name: "Conflict",
          value: "retry-me",
        }),
      );

      expect(yield* executor.secrets.get("conflict")).toBe("retry-me");

      const listed = yield* executor.secrets.list();
      expect(listed.map((s) => s.id)).toEqual(["conflict"]);
    }),
  );
});
