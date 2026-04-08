// ---------------------------------------------------------------------------
// Postgres-backed SecretStore — encrypted values stored directly in DB
// ---------------------------------------------------------------------------

import { Effect, Option } from "effect";
import { eq, and } from "drizzle-orm";

import { SecretRef, SecretId, ScopeId } from "@executor/core";
import type { DrizzleDb } from "./types";
import { SecretNotFoundError, SecretResolutionError } from "@executor/core";
import type { SecretProvider, SetSecretInput } from "@executor/core";

import { secrets } from "./schema";
import { encrypt, decrypt } from "./crypto";

export const makePgSecretStore = (
  db: DrizzleDb,
  teamId: string,
  encryptionKey: string,
) => {
  // Additional providers can still be registered (e.g. 1Password read-only)
  const providers: SecretProvider[] = [];

  return {
    list: (scopeId: ScopeId) =>
      Effect.gen(function* () {
        const rows = yield* Effect.tryPromise(() =>
          db.select().from(secrets).where(eq(secrets.teamId, teamId)),
        ).pipe(Effect.orDie);

        const refs: SecretRef[] = rows.map(
          (row) =>
            new SecretRef({
              id: SecretId.make(row.id),
              scopeId,
              name: row.name,
              provider: Option.some("postgres-encrypted"),
              purpose: row.purpose ?? undefined,
              createdAt: row.createdAt,
            }),
        );

        // Merge in enumerable provider secrets
        const seenIds = new Set(refs.map((r) => r.id));
        for (const provider of providers) {
          if (!provider.list) continue;
          const items = yield* provider.list().pipe(
            Effect.orElseSucceed(() => [] as { id: string; name: string }[]),
          );
          for (const item of items) {
            if (seenIds.has(item.id as SecretId)) continue;
            seenIds.add(item.id as SecretId);
            refs.push(
              new SecretRef({
                id: SecretId.make(item.id),
                scopeId,
                name: item.name,
                provider: Option.some(provider.key),
                purpose: undefined,
                createdAt: new Date(),
              }),
            );
          }
        }

        return refs;
      }),

    get: (secretId: SecretId) =>
      Effect.gen(function* () {
        const rows = yield* Effect.tryPromise(() =>
          db
            .select()
            .from(secrets)
            .where(and(eq(secrets.id, secretId), eq(secrets.teamId, teamId))),
        ).pipe(Effect.orDie);

        const row = rows[0];
        if (!row) return yield* new SecretNotFoundError({ secretId });
        return new SecretRef({
          id: SecretId.make(row.id),
          scopeId: ScopeId.make(teamId),
          name: row.name,
          provider: Option.some("postgres-encrypted"),
          purpose: row.purpose ?? undefined,
          createdAt: row.createdAt,
        });
      }),

    resolve: (secretId: SecretId, _scopeId: ScopeId) =>
      Effect.gen(function* () {
        // Try DB first
        const rows = yield* Effect.tryPromise(() =>
          db
            .select()
            .from(secrets)
            .where(and(eq(secrets.id, secretId), eq(secrets.teamId, teamId))),
        ).pipe(Effect.orDie);

        const row = rows[0];
        if (row) {
          const decrypted = yield* Effect.try({
            try: () => decrypt(row.encryptedValue, row.iv, encryptionKey),
            catch: () =>
              new SecretResolutionError({
                secretId,
                message: `Failed to decrypt secret "${secretId}"`,
              }),
          });
          return decrypted;
        }

        // Fall back to registered providers
        for (const provider of providers) {
          const value = yield* provider.get(secretId);
          if (value !== null) return value;
        }

        return yield* new SecretResolutionError({
          secretId,
          message: `Secret "${secretId}" not found in DB or any provider`,
        });
      }),

    status: (secretId: SecretId, _scopeId: ScopeId) =>
      Effect.gen(function* () {
        const rows = yield* Effect.tryPromise(() =>
          db
            .select({ id: secrets.id })
            .from(secrets)
            .where(and(eq(secrets.id, secretId), eq(secrets.teamId, teamId))),
        ).pipe(Effect.orDie);

        if (rows.length > 0) return "resolved" as const;

        // Check providers
        for (const provider of providers) {
          const value = yield* provider.get(secretId);
          if (value !== null) return "resolved" as const;
        }

        return "missing" as const;
      }),

    set: (input: SetSecretInput) =>
      Effect.gen(function* () {
        const { encrypted, iv } = encrypt(input.value, encryptionKey);

        yield* Effect.tryPromise(() =>
          db
            .insert(secrets)
            .values({
              id: input.id,
              teamId,
              name: input.name,
              purpose: input.purpose,
              encryptedValue: encrypted,
              iv,
            })
            .onConflictDoUpdate({
              target: [secrets.id, secrets.teamId],
              set: {
                name: input.name,
                purpose: input.purpose,
                encryptedValue: encrypted,
                iv,
              },
            }),
        ).pipe(Effect.orDie);

        return new SecretRef({
          id: input.id,
          scopeId: input.scopeId,
          name: input.name,
          provider: Option.some("postgres-encrypted"),
          purpose: input.purpose,
          createdAt: new Date(),
        });
      }),

    remove: (secretId: SecretId) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise(() =>
          db
            .delete(secrets)
            .where(and(eq(secrets.id, secretId), eq(secrets.teamId, teamId)))
            .returning(),
        ).pipe(Effect.orDie);

        if (result.length === 0) {
          return yield* new SecretNotFoundError({ secretId });
        }
        return true;
      }),

    addProvider: (provider: SecretProvider) =>
      Effect.sync(() => { providers.push(provider); }),

    providers: () =>
      Effect.sync(() => ["postgres-encrypted", ...providers.map((p) => p.key)]),
  };
};
