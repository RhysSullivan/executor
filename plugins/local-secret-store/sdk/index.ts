import * as Effect from "effect/Effect";

import {
  defineExecutorSecretStorePlugin,
} from "@executor/platform-sdk/plugins";

export const LOCAL_SECRET_STORE_KIND = "local";
export const LOCAL_SECRET_STORE_ID = "sts_builtin_local";

type LocalSecretStoredData = {
  value: string;
};

const builtinSecretStoreStorage = <TStored>(value: TStored) => ({
  get: () => Effect.succeed(value),
  put: () => Effect.void,
  remove: () => Effect.void,
});

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const localSecretStoreSdkPlugin = defineExecutorSecretStorePlugin<
  typeof LOCAL_SECRET_STORE_KIND,
  unknown,
  { name: string },
  { kind: typeof LOCAL_SECRET_STORE_KIND; name: string },
  {},
  LocalSecretStoredData,
  {
    storeId: string;
    config: { kind: typeof LOCAL_SECRET_STORE_KIND; name: string };
  }
>({
  key: LOCAL_SECRET_STORE_KIND,
  secretStore: {
    kind: LOCAL_SECRET_STORE_KIND,
    displayName: "Local Store",
    builtin: {
      storeId: LOCAL_SECRET_STORE_ID,
      defaultPriority: 100,
      createStore: () => ({
        kind: LOCAL_SECRET_STORE_KIND,
        name: "Local Store",
        status: "connected",
        enabled: true,
      }),
    },
    storage: builtinSecretStoreStorage({}),
    store: {
      create: (input: { name: string }) => ({
        store: {
          kind: LOCAL_SECRET_STORE_KIND,
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
        kind: LOCAL_SECRET_STORE_KIND,
        name: store.name,
      }),
      resolveSecret: ({ secretStored }) => Effect.succeed(secretStored.value),
      createSecret: ({ value, name }) =>
        Effect.succeed({
          name: trimOrNull(name),
          secretStored: {
            value,
          } satisfies LocalSecretStoredData,
        }),
      updateSecret: ({ secret, secretStored, name, value }) =>
        Effect.succeed({
          name: trimOrNull(name ?? secret.name),
          secretStored: {
            value: value ?? secretStored.value,
          } satisfies LocalSecretStoredData,
        }),
      deleteSecret: () => Effect.succeed(true),
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
