// ---------------------------------------------------------------------------
// Storage-backed SecretStore
//
// Implements SecretStoreService on top of a generic ExecutorStorage using
// the core `secrets` model. Encrypted values round-trip through the
// storage `bytes` logical type. Plaintext never touches storage — encrypt
// on write, decrypt on read, all inside this layer.
// ---------------------------------------------------------------------------

import { Effect, Option } from "effect";
import type { ExecutorStorage } from "@executor/storage";

import type { Scope } from "../scope";
import { SecretId, ScopeId } from "../ids";
import { SecretNotFoundError, SecretResolutionError } from "../errors";
import {
  SecretRef,
  type SecretProvider,
  type SetSecretInput,
} from "../secrets";
import { encrypt, decrypt } from "./crypto";

const STORAGE_PROVIDER_KEY = "storage-encrypted";

type SecretRow = {
  readonly id: string;
  readonly scopeId: string;
  readonly name: string;
  readonly purpose?: string | null;
  readonly provider?: string | null;
  readonly encryptedValue?: Uint8Array | null;
  readonly iv?: Uint8Array | null;
  readonly createdAt: Date;
};

const toBuffer = (value: Uint8Array | null | undefined): Buffer | null => {
  if (value == null) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
};

const rowToRef = (row: SecretRow, scopeId: ScopeId): SecretRef =>
  new SecretRef({
    id: SecretId.make(row.id),
    scopeId,
    name: row.name,
    provider: Option.some(row.provider ?? STORAGE_PROVIDER_KEY),
    purpose: row.purpose ?? undefined,
    createdAt: row.createdAt,
  });

export interface StorageSecretStoreOptions {
  readonly encryptionKey: string;
  readonly providers?: readonly SecretProvider[];
}

export const makeStorageSecretStore = (
  storage: ExecutorStorage,
  scope: Scope,
  options: StorageSecretStoreOptions,
) => {
  const scopeIdString = scope.id as string;
  const providers: SecretProvider[] = [...(options.providers ?? [])];

  const getRow = (secretId: SecretId) =>
    storage
      .findOne<SecretRow>({
        model: "secrets",
        where: [
          { field: "id", value: secretId as string },
          { field: "scopeId", value: scopeIdString },
        ],
      })
      .pipe(Effect.orDie);

  return {
    list: (_scopeId: ScopeId) =>
      Effect.gen(function* () {
        const rows = yield* storage
          .findMany<SecretRow>({
            model: "secrets",
            where: [{ field: "scopeId", value: scopeIdString }],
          })
          .pipe(Effect.orDie);

        const refs: SecretRef[] = rows.map((row) => rowToRef(row, scope.id));
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
        return rowToRef(row, scope.id);
      }),

    resolve: (secretId: SecretId, _scopeId: ScopeId) =>
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

    status: (secretId: SecretId, _scopeId: ScopeId) =>
      Effect.gen(function* () {
        const row = yield* getRow(secretId);
        if (row) {
          // For a provider-pinned ref, confirm the provider actually has it.
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

          const refData = {
            id: input.id as string,
            scopeId: scopeIdString,
            name: input.name,
            purpose: input.purpose ?? null,
            provider: providerKey,
            encryptedValue: null as Uint8Array | null,
            iv: null as Uint8Array | null,
          };

          const updated = yield* storage
            .update<SecretRow>({
              model: "secrets",
              where: [
                { field: "id", value: input.id as string },
                { field: "scopeId", value: scopeIdString },
              ],
              update: {
                name: refData.name,
                purpose: refData.purpose,
                provider: refData.provider,
                encryptedValue: refData.encryptedValue,
                iv: refData.iv,
              },
            })
            .pipe(Effect.orDie);

          if (!updated) {
            yield* storage
              .create<SecretRow>({ model: "secrets", data: refData })
              .pipe(Effect.orDie);
          }

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

        const data = {
          id: input.id as string,
          scopeId: scopeIdString,
          name: input.name,
          purpose: input.purpose ?? null,
          provider: STORAGE_PROVIDER_KEY,
          encryptedValue: encrypted,
          iv,
        };

        const updated = yield* storage
          .update<SecretRow>({
            model: "secrets",
            where: [
              { field: "id", value: input.id as string },
              { field: "scopeId", value: scopeIdString },
            ],
            update: {
              name: data.name,
              purpose: data.purpose,
              provider: data.provider,
              encryptedValue: data.encryptedValue,
              iv: data.iv,
            },
          })
          .pipe(Effect.orDie);

        if (!updated) {
          yield* storage
            .create<SecretRow>({
              model: "secrets",
              data,
            })
            .pipe(Effect.orDie);
        }

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

        yield* storage
          .delete({
            model: "secrets",
            where: [
              { field: "id", value: secretId as string },
              { field: "scopeId", value: scopeIdString },
            ],
          })
          .pipe(Effect.orDie);

        return true;
      }),

    addProvider: (provider: SecretProvider) =>
      Effect.sync(() => {
        providers.push(provider);
      }),

    providers: () =>
      Effect.sync(() => [STORAGE_PROVIDER_KEY, ...providers.map((provider) => provider.key)]),
  };
};
