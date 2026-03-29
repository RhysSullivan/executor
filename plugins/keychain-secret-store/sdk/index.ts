import { randomUUID } from "node:crypto";
import {
  Entry,
} from "@napi-rs/keyring";

import * as Effect from "effect/Effect";

import {
  defineExecutorSecretStorePlugin,
} from "@executor/platform-sdk/plugins";
import {
  runtimeEffectError,
} from "@executor/platform-sdk/runtime";

export const KEYCHAIN_SECRET_STORE_KIND = "keychain";
export const KEYCHAIN_SECRET_STORE_ID = "sts_builtin_keychain";

type KeychainSecretStoredData = {
  account: string;
};

const DEFAULT_KEYCHAIN_SERVICE_NAME = "executor";
const KEYCHAIN_SERVICE_NAME_ENV = "EXECUTOR_KEYCHAIN_SERVICE_NAME";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const resolveKeychainServiceName = (value: string | undefined): string =>
  trimOrNull(value)
  ?? trimOrNull(process.env[KEYCHAIN_SERVICE_NAME_ENV])
  ?? DEFAULT_KEYCHAIN_SERVICE_NAME;

const isSupportedPlatform = () =>
  process.platform === "darwin"
  || process.platform === "linux"
  || process.platform === "win32";

const keychainDisplayName = () =>
  process.platform === "darwin"
    ? "macOS Keychain"
    : process.platform === "win32"
      ? "Windows Credential Manager"
      : "Desktop Keyring";

const createKeyringEntry = (input: {
  providerHandle: string;
  keychainServiceName: string;
}) =>
  Effect.try({
    try: () => {
      if (!isSupportedPlatform()) {
        throw runtimeEffectError(
          "plugin-keychain-secret-store",
          `system-keyring: unsupported on platform '${process.platform}'`,
        );
      }

      return new Entry(input.keychainServiceName, input.providerHandle);
    },
    catch: toError,
  });

const readKeychainSecretValue = (input: {
  providerHandle: string;
  keychainServiceName: string;
}) =>
  Effect.flatMap(
    createKeyringEntry(input),
    (entry) =>
      Effect.try({
        try: () => entry.getPassword(),
        catch: toError,
      }).pipe(
        Effect.flatMap((value) =>
          value !== null
            ? Effect.succeed(value)
            : Effect.fail(
                runtimeEffectError(
                  "plugin-keychain-secret-store",
                  `keychain.get: secret not found for service '${input.keychainServiceName}' and account '${input.providerHandle}'`,
                ),
              )),
      ),
  );

const writeKeychainSecretValue = (input: {
  providerHandle: string;
  name?: string | null;
  value: string;
  keychainServiceName: string;
}) =>
  Effect.flatMap(
    createKeyringEntry(input),
    (entry) =>
      Effect.try({
        try: () => entry.setPassword(input.value),
        catch: (cause) =>
          runtimeEffectError(
            "plugin-keychain-secret-store",
            `keychain.put: Failed storing secret in ${keychainDisplayName().toLowerCase()}: ${toError(cause).message}`,
          ),
      }).pipe(Effect.asVoid),
  );

const deleteKeychainSecretValue = (input: {
  providerHandle: string;
  keychainServiceName: string;
}) =>
  Effect.flatMap(
    createKeyringEntry(input),
    (entry) =>
      Effect.try({
        try: () => entry.deletePassword(),
        catch: (cause) =>
          runtimeEffectError(
            "plugin-keychain-secret-store",
            `keychain.delete: Failed deleting secret from ${keychainDisplayName().toLowerCase()}: ${toError(cause).message}`,
          ),
      }),
  );

const builtinSecretStoreStorage = <TStored>(value: TStored) => ({
  get: () => Effect.succeed(value),
  put: () => Effect.void,
  remove: () => Effect.void,
});

export const keychainSecretStoreSdkPlugin = defineExecutorSecretStorePlugin<
  typeof KEYCHAIN_SECRET_STORE_KIND,
  unknown,
  { name: string },
  { kind: typeof KEYCHAIN_SECRET_STORE_KIND; name: string },
  {},
  KeychainSecretStoredData,
  {
    storeId: string;
    config: { kind: typeof KEYCHAIN_SECRET_STORE_KIND; name: string };
  }
>({
  key: KEYCHAIN_SECRET_STORE_KIND,
  secretStore: {
    kind: KEYCHAIN_SECRET_STORE_KIND,
    displayName: keychainDisplayName(),
    builtin: {
      storeId: KEYCHAIN_SECRET_STORE_ID,
      defaultPriority: 10,
      enabled: isSupportedPlatform,
      createStore: () => ({
        kind: KEYCHAIN_SECRET_STORE_KIND,
        name: keychainDisplayName(),
        status: "connected",
        enabled: true,
      }),
    },
    storage: builtinSecretStoreStorage({}),
    store: {
      create: (input: { name: string }) => ({
        store: {
          kind: KEYCHAIN_SECRET_STORE_KIND,
          name: input.name,
          status: "connected",
          enabled: true,
        },
        stored: {},
      }),
      update: ({ store }) => ({
        store,
        stored: {},
      }),
      toConfig: ({ store }) => ({
        kind: KEYCHAIN_SECRET_STORE_KIND,
        name: store.name,
      }),
      resolveSecret: ({ secretStored }) =>
        readKeychainSecretValue({
          providerHandle: secretStored.account,
          keychainServiceName: resolveKeychainServiceName(undefined),
        }),
      createSecret: ({ value, name }) =>
        Effect.gen(function* () {
          const account = randomUUID();
          yield* writeKeychainSecretValue({
            providerHandle: account,
            name,
            value,
            keychainServiceName: resolveKeychainServiceName(undefined),
          });
          return {
            name: trimOrNull(name),
            secretStored: {
              account,
            } satisfies KeychainSecretStoredData,
          };
        }),
      updateSecret: ({ secret, secretStored, name, value }) =>
        Effect.gen(function* () {
          const keychainServiceName = resolveKeychainServiceName(undefined);
          const nextName = trimOrNull(name ?? secret.name);
          const nextValue = value
            ?? (yield* readKeychainSecretValue({
              providerHandle: secretStored.account,
              keychainServiceName,
            }));
          yield* writeKeychainSecretValue({
            providerHandle: secretStored.account,
            name: nextName,
            value: nextValue,
            keychainServiceName,
          });
          return {
            name: nextName,
            secretStored,
          };
        }),
      deleteSecret: ({ secretStored }) =>
        deleteKeychainSecretValue({
          providerHandle: secretStored.account,
          keychainServiceName: resolveKeychainServiceName(undefined),
        }),
      capabilities: () => ({
        canCreateSecrets: true,
        canUpdateSecrets: true,
        canDeleteSecrets: true,
        canBrowseSecrets: false,
        canImportSecrets: false,
      }),
    },
  },
});
