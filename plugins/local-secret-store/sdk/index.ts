import { randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";

import {
  defineExecutorSecretStorePlugin,
} from "@executor/platform-sdk/plugins";
import {
  runtimeEffectError,
} from "@executor/platform-sdk/runtime";

export const LOCAL_SECRET_STORE_KIND = "local";
export const LOCAL_SECRET_STORE_ID = "sts_builtin_local";

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

export const localSecretStoreSdkPlugin = defineExecutorSecretStorePlugin({
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
      resolveSecret: ({ secret }) => {
        if (secret.value === null) {
          return Effect.fail(
            runtimeEffectError(
              "plugin-local-secret-store",
              `Local secret ${secret.id} does not have a stored value`,
            ),
          );
        }

        return Effect.succeed(secret.value);
      },
      createSecret: ({ value, name }) =>
        Effect.succeed({
          handle: `local:${randomUUID()}`,
          name: trimOrNull(name),
          value,
        }),
      updateSecret: ({ secret, name, value }) =>
        Effect.succeed({
          handle: secret.handle,
          name: trimOrNull(name ?? secret.name),
          ...(value !== undefined ? { value } : {}),
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
