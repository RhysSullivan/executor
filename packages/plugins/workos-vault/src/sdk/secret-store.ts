import { Effect } from "effect";
import { GenericServerException, NotFoundException } from "@workos-inc/node/worker";

import {
  defineSchema,
  StorageError,
  type SecretProvider,
  type StorageDeps,
  type StorageFailure,
} from "@executor/sdk";

import {
  WorkOSVaultClientError,
  type WorkOSVaultClient,
  type WorkOSVaultObject,
} from "./client";

export const WORKOS_VAULT_PROVIDER_KEY = "workos-vault";

const DEFAULT_OBJECT_PREFIX = "executor";
const MAX_WRITE_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Metadata schema — the plugin owns its own table for secret metadata
// (name, purpose, created_at). Values still live in WorkOS Vault; this
// table just tracks what we know about and lets us enumerate.
// ---------------------------------------------------------------------------

export const workosVaultSchema = defineSchema({
  workos_vault_metadata: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      purpose: { type: "string", required: false },
      created_at: { type: "date", required: true },
    },
  },
});

export type WorkosVaultSchema = typeof workosVaultSchema;

interface MetadataRow {
  readonly id: string;
  /** Populated on rows read from the adapter (which stamps scope_id);
   *  absent on upsert inputs since the adapter fills it from the
   *  executor's write target. */
  readonly scope_id?: string;
  readonly name: string;
  readonly purpose?: string | null;
  readonly created_at: Date;
}

// ---------------------------------------------------------------------------
// WorkosVaultStore — typed metadata-store the plugin uses internally.
// ---------------------------------------------------------------------------

export interface WorkosVaultStore {
  readonly get: (id: string) => Effect.Effect<MetadataRow | null, StorageFailure>;
  readonly upsert: (row: MetadataRow) => Effect.Effect<void, StorageFailure>;
  readonly remove: (id: string) => Effect.Effect<boolean, StorageFailure>;
  readonly list: () => Effect.Effect<readonly MetadataRow[], StorageFailure>;
}

export const makeWorkosVaultStore = (
  deps: StorageDeps<WorkosVaultSchema>,
): WorkosVaultStore => {
  const { adapter: db } = deps;

  const findOne = (id: string) =>
    db
      .findOne({
        model: "workos_vault_metadata",
        where: [{ field: "id", value: id }],
      })
      .pipe(Effect.map((row): MetadataRow | null => row ?? null));

  return {
    get: (id) => findOne(id),
    upsert: (row) =>
      Effect.gen(function* () {
        const existing = yield* findOne(row.id);
        if (existing) {
          yield* db.update({
            model: "workos_vault_metadata",
            where: [{ field: "id", value: row.id }],
            update: {
              name: row.name,
              purpose: row.purpose ?? null,
              // created_at preserved from existing
            },
          });
          return;
        }
        yield* db.create({
          model: "workos_vault_metadata",
          data: {
            id: row.id,
            name: row.name,
            purpose: row.purpose ?? null,
            created_at: row.created_at,
          },
          forceAllowId: true,
        });
      }),
    remove: (id) =>
      Effect.gen(function* () {
        const existing = yield* findOne(id);
        if (!existing) return false;
        yield* db.delete({
          model: "workos_vault_metadata",
          where: [{ field: "id", value: id }],
        });
        return true;
      }),
    list: () =>
      db.findMany({ model: "workos_vault_metadata" }).pipe(
        Effect.map((rows): readonly MetadataRow[] =>
          [...rows].sort(
            (l, r) => l.created_at.getTime() - r.created_at.getTime(),
          ),
        ),
      ),
  };
};

// ---------------------------------------------------------------------------
// Vault helpers — scope-prefixed object naming + 409-retry upsert.
// ---------------------------------------------------------------------------

const unwrapVaultError = (error: unknown): unknown =>
  error instanceof WorkOSVaultClientError ? error.cause : error;

const isStatusError = (error: unknown, status: number): boolean => {
  const cause = unwrapVaultError(error);
  return (
    ((cause instanceof GenericServerException ||
      cause instanceof NotFoundException) &&
      cause.status === status) ||
    (typeof cause === "object" &&
      cause !== null &&
      "status" in cause &&
      typeof (cause as { status: unknown }).status === "number" &&
      (cause as { status: number }).status === status)
  );
};

const objectContext = (scopeId: string): Record<string, string> => ({
  app: "executor",
  organization_id: scopeId,
  scope_id: scopeId,
});

const secretObjectName = (
  prefix: string,
  scopeId: string,
  secretId: string,
): string => `${prefix}/${scopeId}/secrets/${secretId}`;

const loadSecretObject = (
  client: WorkOSVaultClient,
  prefix: string,
  scopeId: string,
  secretId: string,
): Effect.Effect<WorkOSVaultObject | null, WorkOSVaultClientError, never> =>
  client.readObjectByName(secretObjectName(prefix, scopeId, secretId)).pipe(
    Effect.catchAll((error) =>
      isStatusError(error, 404) ? Effect.succeed(null) : Effect.fail(error),
    ),
  );

const upsertSecretValue = (
  client: WorkOSVaultClient,
  prefix: string,
  scopeId: string,
  secretId: string,
  value: string,
): Effect.Effect<void, WorkOSVaultClientError, never> => {
  const attemptWrite = (
    remainingAttempts: number,
  ): Effect.Effect<void, WorkOSVaultClientError, never> =>
    Effect.gen(function* () {
      const existing = yield* loadSecretObject(client, prefix, scopeId, secretId);

      if (existing) {
        yield* client.updateObject({
          id: existing.id,
          value,
          versionCheck: existing.metadata.versionId,
        });
        return;
      }

      yield* client.createObject({
        name: secretObjectName(prefix, scopeId, secretId),
        value,
        context: objectContext(scopeId),
      });
    }).pipe(
      Effect.catchAll((error) => {
        if (remainingAttempts > 1 && isStatusError(error, 409)) {
          return attemptWrite(remainingAttempts - 1);
        }
        return Effect.fail(error);
      }),
    );

  return attemptWrite(MAX_WRITE_ATTEMPTS);
};

const deleteSecretValue = (
  client: WorkOSVaultClient,
  prefix: string,
  scopeId: string,
  secretId: string,
): Effect.Effect<boolean, WorkOSVaultClientError, never> =>
  Effect.gen(function* () {
    const existing = yield* loadSecretObject(client, prefix, scopeId, secretId);
    if (!existing) return false;
    yield* client.deleteObject({ id: existing.id });
    return true;
  });

const formatVaultError = (error: unknown): StorageError => {
  const cause = unwrapVaultError(error);
  const message = cause instanceof Error ? cause.message : String(cause);
  return new StorageError({ message, cause });
};

// ---------------------------------------------------------------------------
// makeWorkOSVaultSecretProvider — builds a SecretProvider backed by
// WorkOS Vault for values and the plugin's own metadata table for
// names/purpose/createdAt.
// ---------------------------------------------------------------------------

export interface WorkOSVaultSecretProviderOptions {
  readonly client: WorkOSVaultClient;
  readonly store: WorkosVaultStore;
  readonly scopeId: string;
  readonly objectPrefix?: string;
}

export const makeWorkOSVaultSecretProvider = (
  options: WorkOSVaultSecretProviderOptions,
): SecretProvider => {
  const prefix = options.objectPrefix ?? DEFAULT_OBJECT_PREFIX;
  const { client, store } = options;
  // Default scope — used when the executor doesn't pass one (fallback
  // providers, legacy single-scope hosts). The executor passes the
  // winning scope on every layered call so `get`/`delete`/`set` hit
  // the right vault keyspace.
  const defaultScope = options.scopeId;

  return {
    key: WORKOS_VAULT_PROVIDER_KEY,
    writable: true,

    get: (id, scopeOverride) =>
      Effect.gen(function* () {
        const targetScope = scopeOverride ?? defaultScope;
        const meta = yield* store.get(id);
        if (!meta) return null;
        const object = yield* loadSecretObject(
          client,
          prefix,
          targetScope,
          id,
        ).pipe(Effect.mapError(formatVaultError));
        if (!object || !object.value) return null;
        return object.value;
      }),

    set: (id, value, scopeOverride) =>
      Effect.gen(function* () {
        const targetScope = scopeOverride ?? defaultScope;
        const existing = yield* store.get(id);
        yield* upsertSecretValue(client, prefix, targetScope, id, value).pipe(
          Effect.mapError(formatVaultError),
        );
        yield* store.upsert({
          id,
          name: existing?.name ?? id,
          purpose: existing?.purpose ?? null,
          created_at: existing?.created_at ?? new Date(),
        });
      }),

    delete: (id, scopeOverride) =>
      Effect.gen(function* () {
        const targetScope = scopeOverride ?? defaultScope;
        const meta = yield* store.get(id);
        if (!meta) return false;
        yield* deleteSecretValue(client, prefix, targetScope, id).pipe(
          Effect.mapError(formatVaultError),
        );
        yield* store.remove(id);
        return true;
      }),

    list: (scopeOverride) =>
      // The metadata store is already adapter-scoped so it will
      // enumerate whatever's visible in the executor's read chain.
      // When `scopeOverride` is passed, filter to just that scope so
      // the executor's per-scope walk produces scope-stamped entries.
      store
        .list()
        .pipe(
          Effect.map((rows) =>
            rows
              .filter((r) =>
                scopeOverride ? r.scope_id === scopeOverride : true,
              )
              .map((r) => ({ id: r.id, name: r.name })),
          ),
        ),
  };
};
