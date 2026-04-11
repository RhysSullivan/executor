// ---------------------------------------------------------------------------
// makeSecretManager — service factory for the SecretManager Context.Tag.
//
// Ports business logic from storage-stores/secret-store.ts, replacing
// ExecutorStorage CRUD calls with typed SecretStore methods.
// Encryption lives in services/crypto.ts.
// ---------------------------------------------------------------------------

import { Effect, Option } from "effect";
import type { Context } from "effect";

import type { Scope } from "../scope";
import { SecretId } from "../ids";
import { SecretNotFoundError, SecretResolutionError } from "../errors";
import { SecretRef, type SecretProvider, type SetSecretInput } from "../secrets";
import { SecretManager } from "../secrets";
import { encrypt, decrypt } from "./crypto";
import type { SecretStore } from "../stores/secret-store";
import type { SecretRow } from "../stores/secret-store";
import { rowToSecretRef } from "../stores/mappers/secret";

const STORAGE_PROVIDER_KEY = "storage-encrypted";

const toBuffer = (value: Uint8Array | null | undefined): Buffer | null => {
  if (value == null) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
};

export interface SecretManagerOptions {
  readonly encryptionKey: string;
  readonly providers?: readonly SecretProvider[];
}

export const makeSecretManager = (
  store: SecretStore,
  scope: Scope,
  options: SecretManagerOptions,
): Context.Tag.Service<typeof SecretManager> => {
  const providers: SecretProvider[] = [...(options.providers ?? [])];

  const getRow = (secretId: SecretId) => store.findById(secretId, scope.id);

  return {
    list: (_scopeId) =>
      Effect.gen(function* () {
        const rows = yield* store.findByScope(scope.id);
        const refs: SecretRef[] = rows.map((row) => rowToSecretRef(row, scope.id));
        const seen = new Set(refs.map((ref) => ref.id as string));

        for (const provider of providers) {
          if (!provider.list) continue;
          const items = yield* provider
            .list()
            .pipe(Effect.orElseSucceed(() => [] as readonly { id: string; name: string }[]));
          for (const item of items) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            refs.push(
              new SecretRef({
                id: SecretId.make(item.id),
                scopeId: scope.id,
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
        const row = yield* getRow(secretId);
        if (!row) return yield* new SecretNotFoundError({ secretId });
        return rowToSecretRef(row, scope.id);
      }),

    resolve: (secretId: SecretId, _scopeId) =>
      Effect.gen(function* () {
        const row = yield* getRow(secretId);
        if (row) {
          // Provider-pinned ref: delegate to the named provider.
          if (row.provider && row.provider !== STORAGE_PROVIDER_KEY) {
            const provider = providers.find((p) => p.key === row.provider);
            if (provider) {
              const value = yield* provider.get(secretId);
              if (value !== null) return value;
            }
          } else {
            // Storage-encrypted ref: decrypt in-place.
            const encryptedValue = toBuffer(row.encryptedValue);
            const iv = toBuffer(row.iv);
            if (encryptedValue && iv) {
              return yield* Effect.try({
                try: () => decrypt(encryptedValue, iv, options.encryptionKey),
                catch: () =>
                  new SecretResolutionError({
                    secretId,
                    message: `Failed to decrypt secret "${secretId}"`,
                  }),
              });
            }
          }
        }

        for (const provider of providers) {
          const value = yield* provider.get(secretId);
          if (value !== null) return value;
        }

        return yield* new SecretResolutionError({
          secretId,
          message: `Secret "${secretId}" not found in storage or any provider`,
        });
      }),

    status: (secretId: SecretId, _scopeId) =>
      Effect.gen(function* () {
        const row = yield* getRow(secretId);
        if (row) {
          if (row.provider && row.provider !== STORAGE_PROVIDER_KEY) {
            const provider = providers.find((p) => p.key === row.provider);
            if (provider) {
              const value = yield* provider.get(secretId);
              return value !== null ? ("resolved" as const) : ("missing" as const);
            }
            return "missing" as const;
          }
          return "resolved" as const;
        }
        for (const provider of providers) {
          const value = yield* provider.get(secretId);
          if (value !== null) return "resolved" as const;
        }
        return "missing" as const;
      }),

    set: (input: SetSecretInput) =>
      Effect.gen(function* () {
        const providerKey = input.provider;

        // Provider-pinned path: delegate the plaintext to a named writable
        // provider and store only metadata in the `secrets` model.
        if (providerKey && providerKey !== STORAGE_PROVIDER_KEY) {
          const provider = providers.find((p) => p.key === providerKey);
          if (!provider?.set) {
            return yield* new SecretResolutionError({
              secretId: input.id,
              message: `No writable provider "${providerKey}" registered`,
            });
          }

          yield* provider.set(input.id as string, input.value);

          const row: SecretRow = {
            id: input.id as string,
            scopeId: scope.id as string,
            name: input.name,
            purpose: input.purpose ?? null,
            provider: providerKey,
            encryptedValue: null,
            iv: null,
            createdAt: new Date(),
          };

          yield* store.upsert(row);

          return new SecretRef({
            id: input.id,
            scopeId: input.scopeId,
            name: input.name,
            provider: Option.some(providerKey),
            purpose: input.purpose,
            createdAt: new Date(),
          });
        }

        // Default path: encrypt and persist inside storage.
        const { encrypted, iv } = encrypt(input.value, options.encryptionKey);

        const row: SecretRow = {
          id: input.id as string,
          scopeId: scope.id as string,
          name: input.name,
          purpose: input.purpose ?? null,
          provider: STORAGE_PROVIDER_KEY,
          encryptedValue: encrypted,
          iv,
          createdAt: new Date(),
        };

        yield* store.upsert(row);

        return new SecretRef({
          id: input.id,
          scopeId: input.scopeId,
          name: input.name,
          provider: Option.some(STORAGE_PROVIDER_KEY),
          purpose: input.purpose,
          createdAt: new Date(),
        });
      }),

    remove: (secretId: SecretId) =>
      Effect.gen(function* () {
        const row = yield* getRow(secretId);
        if (!row) return yield* new SecretNotFoundError({ secretId });

        if (row.provider && row.provider !== STORAGE_PROVIDER_KEY) {
          const provider = providers.find((p) => p.key === row.provider);
          if (provider?.delete) {
            yield* provider.delete(secretId as string);
          }
        }

        yield* store.deleteById(secretId, scope.id);
        return true;
      }),

    addProvider: (provider: SecretProvider) =>
      Effect.sync(() => {
        providers.push(provider);
      }),

    providers: () =>
      Effect.sync(() => [STORAGE_PROVIDER_KEY, ...providers.map((p) => p.key)]),
  };
};
