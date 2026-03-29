import {
  createClient,
  DesktopAuth,
  type ItemField,
  ItemCategory,
  ItemFieldType,
  type Item,
} from "@1password/sdk";
import * as Effect from "effect/Effect";

import {
  defineExecutorSecretStorePlugin,
} from "@executor/platform-sdk/plugins";
import {
  SecretMaterialResolverService,
} from "@executor/platform-sdk/runtime";
import type {
  SecretMaterial,
  SecretMaterialPurpose,
  SecretStore,
} from "@executor/platform-sdk/schema";
import {
  SecretMaterialIdSchema,
} from "@executor/platform-sdk/schema";
import {
  ONEPASSWORD_SECRET_FIELD_ID,
  ONEPASSWORD_SECRET_STORE_KIND,
  OnePasswordConnectInputSchema,
  type OnePasswordDiscoverVaultsInput,
  type OnePasswordDiscoverVaultsResult,
  type OnePasswordDiscoverStoreItemsInput,
  type OnePasswordDiscoverStoreItemsResult,
  type OnePasswordDiscoverItemFieldsInput,
  type OnePasswordDiscoverItemFieldsResult,
  type OnePasswordImportSecretInput,
  type OnePasswordImportSecretResult,
  type OnePasswordStoreAuth,
  OnePasswordStoredStoreDataSchema,
  type OnePasswordConnectInput,
  type OnePasswordStoreConfigPayload,
  type OnePasswordStoredStoreData,
  type OnePasswordUpdateStoreInput,
} from "@executor/plugin-onepassword-shared";

export type OnePasswordStoreStorage = {
  get: (input: {
    scopeId: string;
    storeId: string;
  }) => Effect.Effect<OnePasswordStoredStoreData | null, Error, never>;
  put: (input: {
    scopeId: string;
    storeId: string;
    value: OnePasswordStoredStoreData;
  }) => Effect.Effect<void, Error, never>;
  remove?: (input: {
    scopeId: string;
    storeId: string;
  }) => Effect.Effect<void, Error, never>;
};

type OnePasswordSecretStoredData = {
  uri: string;
};

const ONEPASSWORD_REQUEST_TIMEOUT_MS = 15_000;

const timedOutOnePasswordRequestError = (operation: string) =>
  new Error(
    `1Password ${operation} timed out after ${Math.floor(ONEPASSWORD_REQUEST_TIMEOUT_MS / 1000)} seconds. Approve the request in the 1Password desktop app and try again.`,
  );

const runOnePasswordRequest = <T>(
  operation: string,
  effect: () => Promise<T>,
) =>
  new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(timedOutOnePasswordRequestError(operation));
    }, ONEPASSWORD_REQUEST_TIMEOUT_MS);

    effect().then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timeoutId);
        reject(cause);
      },
    );
  });

const resolveServiceAccountToken = (
  auth: Extract<OnePasswordStoreAuth, { kind: "service-account" }>,
) =>
  Effect.gen(function* () {
    const resolveSecretMaterial = yield* SecretMaterialResolverService;
    return yield* resolveSecretMaterial({
      ref: auth.tokenSecretRef,
    });
  });

const makeClientFromAuth = (
  auth: OnePasswordStoreAuth,
) =>
  Effect.gen(function* () {
    const resolvedAuth = auth.kind === "desktop-app"
      ? new DesktopAuth(auth.accountName)
      : yield* resolveServiceAccountToken(auth);

    return yield* Effect.tryPromise({
      try: () =>
        runOnePasswordRequest("client setup", () =>
          createClient({
            auth: resolvedAuth,
            integrationName: "Executor",
            integrationVersion: "0.0.0",
          })
        ),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });
  });

const makeClient = (
  stored: OnePasswordStoredStoreData | null,
) =>
  Effect.gen(function* () {
    if (!stored) {
      throw new Error("1Password store configuration is missing.");
    }

    return yield* makeClientFromAuth(stored.auth);
  });

const importableFieldTypes = new Set<string>([
  ItemFieldType.Concealed,
  ItemFieldType.Text,
]);
const ONEPASSWORD_BROWSE_ITEM_LIMIT = 12;

const toImportableFields = (
  fields: ReadonlyArray<ItemField>,
) =>
  fields
    .filter((field) =>
      importableFieldTypes.has(field.fieldType)
      && field.id.trim().length > 0
      && field.value.trim().length > 0
    )
    .map((field) => ({
      id: field.id,
      title: field.title || field.id,
      fieldType: field.fieldType,
      ...(field.sectionId ? { sectionId: field.sectionId } : {}),
    }));

const itemSelectionKey = (itemId: string) => `item:${itemId}`;
const secretSelectionKey = (itemId: string, fieldId: string) =>
  `secret:${itemId}:${fieldId}`;

const parseSelectionKey = (value: string):
  | {
      kind: "item";
      itemId: string;
    }
  | {
      kind: "secret";
      itemId: string;
      fieldId: string;
    } => {
  const itemMatch = /^item:([^:]+)$/.exec(value);
  if (itemMatch) {
    return {
      kind: "item",
      itemId: itemMatch[1]!,
    };
  }

  const secretMatch = /^secret:([^:]+):([^:]+)$/.exec(value);
  if (secretMatch) {
    return {
      kind: "secret",
      itemId: secretMatch[1]!,
      fieldId: secretMatch[2]!,
    };
  }

  throw new Error(`Invalid 1Password selection key: ${value}`);
};

const discoverVaults = (
  input: OnePasswordDiscoverVaultsInput,
) =>
  Effect.flatMap(makeClientFromAuth(input.auth), (client) =>
    Effect.tryPromise({
      try: async () => {
        const vaults = await runOnePasswordRequest("vault discovery", () =>
          client.vaults.list({ decryptDetails: true })
        );
        return {
          vaults: vaults
            .map((vault) => ({
              id: vault.id,
              name: vault.title,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        } satisfies OnePasswordDiscoverVaultsResult;
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }));

const discoverStoreItems = (input: {
  store: SecretStore;
  stored: OnePasswordStoredStoreData | null;
}) =>
  Effect.flatMap(makeClient(input.stored), (client) =>
    Effect.tryPromise({
      try: async () => {
        const overviews = await runOnePasswordRequest("item discovery", () =>
          client.items.list(input.stored!.vaultId)
        );
        return {
          items: overviews
            .map((item) => ({
              id: item.id,
              title: item.title,
              category: item.category,
            }))
            .sort((left, right) => left.title.localeCompare(right.title)),
        } satisfies OnePasswordDiscoverStoreItemsResult;
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }));

const discoverItemFields = (input: {
  store: SecretStore;
  stored: OnePasswordStoredStoreData | null;
  itemId: string;
}) =>
  Effect.flatMap(makeClient(input.stored), (client) =>
    Effect.tryPromise({
      try: async () => {
        const item = await runOnePasswordRequest("field discovery", () =>
          client.items.get(input.stored!.vaultId, input.itemId)
        );
        return {
          itemId: item.id,
          fields: toImportableFields(item.fields),
        } satisfies OnePasswordDiscoverItemFieldsResult;
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }));

const discoverImportableSecrets = (input: {
  store: SecretStore;
  stored: OnePasswordStoredStoreData | null;
  query?: string | null;
}) =>
  Effect.flatMap(makeClient(input.stored), (client) =>
    Effect.tryPromise({
      try: async () => {
        const normalizedQuery = input.query?.trim().toLowerCase() ?? "";
        const overviews = await runOnePasswordRequest("item discovery", () =>
          client.items.list(input.stored!.vaultId)
        );
        const filteredItems = overviews
          .filter((item) =>
            normalizedQuery.length === 0
            || item.title.toLowerCase().includes(normalizedQuery)
          )
          .slice(0, ONEPASSWORD_BROWSE_ITEM_LIMIT);

        const detailedItems = await Promise.all(
          filteredItems.map((item) =>
            runOnePasswordRequest("field discovery", () =>
              client.items.get(input.stored!.vaultId, item.id)
            ))
        );

        return {
          entries: detailedItems
            .flatMap((item) =>
              toImportableFields(item.fields)
                .filter((field) =>
                  normalizedQuery.length === 0
                  || item.title.toLowerCase().includes(normalizedQuery)
                  || field.title.toLowerCase().includes(normalizedQuery)
                  || field.id.toLowerCase().includes(normalizedQuery)
                )
                .map((field) => ({
                  key: secretSelectionKey(item.id, field.id),
                  label: `${item.title} · ${field.title}`,
                  description: item.category ?? field.fieldType ?? null,
                  kind: "secret" as const,
                }))
            )
            .sort((left, right) => left.label.localeCompare(right.label)),
        };
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }));

const browseSecrets = (input: {
  store: SecretStore;
  stored: OnePasswordStoredStoreData | null;
  parentKey?: string | null;
  query?: string | null;
}) =>
  Effect.gen(function* () {
    const normalizedQuery = input.query?.trim().toLowerCase() ?? "";

    if (!input.parentKey) {
      return yield* discoverImportableSecrets({
        ...input,
        query: normalizedQuery,
      });
    }

    const selection = parseSelectionKey(input.parentKey);
    if (selection.kind !== "item") {
      throw new Error(`Cannot browse children for selection: ${input.parentKey}`);
    }

    const fields = yield* discoverItemFields({
      ...input,
      itemId: selection.itemId,
    });

    return {
      entries: fields.fields
        .filter((field) =>
          normalizedQuery.length === 0
          || field.title.toLowerCase().includes(normalizedQuery)
          || field.id.toLowerCase().includes(normalizedQuery)
        )
        .map((field) => ({
          key: secretSelectionKey(selection.itemId, field.id),
          label: field.title,
          description: field.fieldType ?? null,
          kind: "secret" as const,
        })),
    };
  });

const importSecretFromSelection = (input: {
  store: SecretStore;
  stored: OnePasswordStoredStoreData | null;
  selectionKey: string;
  name?: string | null;
}) =>
  Effect.gen(function* () {
    const selection = parseSelectionKey(input.selectionKey);
    if (selection.kind !== "secret") {
      throw new Error(`1Password selection is not a secret field: ${input.selectionKey}`);
    }

    const items = yield* discoverStoreItems(input);
    const item = items.items.find((candidate) => candidate.id === selection.itemId);
    if (!item) {
      throw new Error(`1Password item not found: ${selection.itemId}`);
    }

    const fields = yield* discoverItemFields({
      ...input,
      itemId: selection.itemId,
    });
    const field = fields.fields.find((candidate) => candidate.id === selection.fieldId);
    if (!field) {
      throw new Error(
        `1Password field not found: ${selection.itemId}/${selection.fieldId}`,
      );
    }

    return {
      secretStored: {
        uri: `op://${input.stored!.vaultId}/${item.id}/${field.id}`,
      } satisfies OnePasswordSecretStoredData,
      name: input.name?.trim() || `${item.title} · ${field.title}`,
    };
  });

const createImportedSecretRecord = (input: {
  executor: {
    runtime: {
      storage: {
        secrets: {
          upsert: (value: SecretMaterial) => Effect.Effect<void, Error, never>;
          secretMaterialStoredData: {
            upsert: (value: {
              secretId: SecretMaterial["id"];
              data: OnePasswordSecretStoredData;
            }) => Effect.Effect<void, Error, never>;
          };
        };
      };
    };
  };
  store: SecretStore;
  secretStored: OnePasswordSecretStoredData;
  name: string | null;
  purpose?: SecretMaterialPurpose;
}): Effect.Effect<OnePasswordImportSecretResult, Error, any> =>
  Effect.gen(function* () {
    const now = Date.now();
    const secret: SecretMaterial = {
      id: SecretMaterialIdSchema.make(`sec_${crypto.randomUUID()}`),
      storeId: input.store.id,
      name: input.name,
      purpose: input.purpose ?? "auth_material",
      createdAt: now,
      updatedAt: now,
    };

    yield* input.executor.runtime.storage.secrets.upsert(secret);
    yield* input.executor.runtime.storage.secrets.secretMaterialStoredData.upsert({
      secretId: secret.id,
      data: input.secretStored,
    });

    return {
      id: secret.id,
      name: secret.name,
      storeId: secret.storeId,
      purpose: secret.purpose,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
    };
  });

const parseSecretReference = (uri: string): {
  vaultId: string;
  itemId: string;
  fieldId: string;
} => {
  const match = /^op:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match) {
    throw new Error(`Invalid 1Password secret reference: ${uri}`);
  }

  return {
    vaultId: match[1]!,
    itemId: match[2]!,
    fieldId: match[3]!,
  };
};

const upsertCredentialField = (item: Item, value: string): Item => {
  const existing = item.fields.find((field) => field.id === ONEPASSWORD_SECRET_FIELD_ID);
  if (existing) {
    existing.value = value;
    return item;
  }

  item.fields.push({
    id: ONEPASSWORD_SECRET_FIELD_ID,
    title: "Credential",
    fieldType: ItemFieldType.Concealed,
    value,
  });
  return item;
};

export const onePasswordSdkPlugin = (input: {
  storage: OnePasswordStoreStorage;
}) =>
  defineExecutorSecretStorePlugin<
    typeof ONEPASSWORD_SECRET_STORE_KIND,
    OnePasswordConnectInput,
    OnePasswordConnectInput,
    OnePasswordStoreConfigPayload,
    OnePasswordStoredStoreData,
    OnePasswordSecretStoredData,
    OnePasswordUpdateStoreInput
  >({
    key: ONEPASSWORD_SECRET_STORE_KIND,
    secretStore: {
      kind: ONEPASSWORD_SECRET_STORE_KIND,
      displayName: "1Password",
      add: {
        inputSchema: OnePasswordConnectInputSchema,
        toConnectInput: (value) => value,
      },
      storage: input.storage,
      store: {
        create: (value) => ({
          store: {
            kind: ONEPASSWORD_SECRET_STORE_KIND,
            name: value.name,
            status: "connected",
            enabled: true,
          },
          stored: {
            vaultId: value.vaultId,
            auth: value.auth,
          },
        }),
        update: ({ store, config }) => ({
          store: {
            ...store,
            name: config.name,
            status: "connected",
          },
          stored: {
            vaultId: config.vaultId,
            auth: config.auth,
          },
        }),
        toConfig: ({ store, stored }) => ({
          kind: ONEPASSWORD_SECRET_STORE_KIND,
          name: store.name,
          vaultId: stored.vaultId,
          auth: stored.auth,
        } satisfies OnePasswordStoreConfigPayload),
        resolveSecret: ({ secretStored, stored }) =>
          Effect.flatMap(makeClient(stored), (client) =>
            Effect.tryPromise({
              try: () =>
                runOnePasswordRequest("secret resolution", () =>
                  client.secrets.resolve(secretStored.uri)
                ),
              catch: (cause) =>
                cause instanceof Error ? cause : new Error(String(cause)),
            })),
        createSecret: ({ stored, value, name }) =>
          Effect.flatMap(makeClient(stored), (client) =>
            Effect.tryPromise({
              try: async () => {
                const item = await runOnePasswordRequest("secret creation", () =>
                  client.items.create({
                    category: ItemCategory.Password,
                    vaultId: stored!.vaultId,
                    title: name?.trim() || "Executor Secret",
                    fields: [
                      {
                        id: ONEPASSWORD_SECRET_FIELD_ID,
                        title: "Credential",
                        fieldType: ItemFieldType.Concealed,
                        value,
                      },
                    ],
                  })
                );

                return {
                  secretStored: {
                    uri: `op://${stored!.vaultId}/${item.id}/${ONEPASSWORD_SECRET_FIELD_ID}`,
                  } satisfies OnePasswordSecretStoredData,
                  name: item.title,
                };
              },
              catch: (cause) =>
                cause instanceof Error ? cause : new Error(String(cause)),
            })),
        updateSecret: ({ secret, secretStored, stored, name, value }) =>
          Effect.flatMap(makeClient(stored), (client) =>
            Effect.tryPromise({
              try: async () => {
                const parsed = parseSecretReference(secretStored.uri);
                const item = await runOnePasswordRequest("secret update", () =>
                  client.items.get(parsed.vaultId, parsed.itemId)
                );
                if (name !== undefined) {
                  item.title = name?.trim() || item.title;
                }
                if (value !== undefined) {
                  upsertCredentialField(item, value);
                }
                const updated = await runOnePasswordRequest("secret update", () =>
                  client.items.put(item)
                );
                return {
                  name: updated.title,
                  secretStored,
                };
              },
              catch: (cause) =>
                cause instanceof Error ? cause : new Error(String(cause)),
            })),
        deleteSecret: ({ secretStored, stored }) =>
          Effect.flatMap(makeClient(stored), (client) =>
            Effect.tryPromise({
              try: async () => {
                const parsed = parseSecretReference(secretStored.uri);
                await runOnePasswordRequest("secret deletion", () =>
                  client.items.delete(parsed.vaultId, parsed.itemId)
                );
                return true;
              },
              catch: (cause) =>
                cause instanceof Error ? cause : new Error(String(cause)),
            })),
        browseSecrets: ({ store, stored, parentKey, query }) =>
          browseSecrets({
            store,
            stored,
            parentKey,
            query,
          }),
        importSecret: ({ store, stored, selectionKey, name }) =>
          importSecretFromSelection({
            store,
            stored,
            selectionKey,
            name,
          }),
        capabilities: () => ({
          canCreateSecrets: true,
          canUpdateSecrets: true,
          canDeleteSecrets: true,
          canBrowseSecrets: true,
          canImportSecrets: true,
        }),
      },
    },
    extendExecutor: ({ executor, secretStore }) => ({
      getStoreConfig: (
        storeId: SecretStore["id"],
      ) => secretStore.getStoreConfig(storeId),
      createStore: (value: OnePasswordConnectInput) =>
        secretStore.createStore(value),
      updateStore: (value: OnePasswordUpdateStoreInput) =>
        secretStore.updateStore(value),
      removeStore: (storeId: SecretStore["id"]) =>
        secretStore.removeStore(storeId),
      discoverVaults: (value: OnePasswordDiscoverVaultsInput) =>
        discoverVaults(value),
      discoverStoreItems: (value: OnePasswordDiscoverStoreItemsInput) =>
        Effect.gen(function* () {
          const store = yield* secretStore.getStore(
            value.storeId as SecretStore["id"],
          );
          const stored = yield* input.storage.get({
            scopeId: store.scopeId,
            storeId: store.id,
          });

          return yield* discoverStoreItems({
            store,
            stored,
          });
        }),
      discoverItemFields: (value: OnePasswordDiscoverItemFieldsInput) =>
        Effect.gen(function* () {
          const store = yield* secretStore.getStore(
            value.storeId as SecretStore["id"],
          );
          const stored = yield* input.storage.get({
            scopeId: store.scopeId,
            storeId: store.id,
          });

          return yield* discoverItemFields({
            store,
            stored,
            itemId: value.itemId,
          });
        }),
      importSecret: (value: OnePasswordImportSecretInput) =>
        Effect.gen(function* () {
          const store = yield* secretStore.getStore(
            value.storeId as SecretStore["id"],
          );
          const stored = yield* input.storage.get({
            scopeId: store.scopeId,
            storeId: store.id,
          });
          const imported = yield* importSecretFromSelection({
            store,
            stored,
            selectionKey: secretSelectionKey(value.itemId, value.fieldId),
            name: value.name?.trim() || null,
          });

          return yield* createImportedSecretRecord({
            executor,
            store,
            secretStored: imported.secretStored,
            name: imported.name,
          });
        }),
    }),
  });

export {
  OnePasswordConnectInputSchema,
  OnePasswordStoredStoreDataSchema,
};
