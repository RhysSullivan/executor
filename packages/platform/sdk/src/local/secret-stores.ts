import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  type BrowseSecretStorePayload,
  type BrowseSecretStoreResult,
  type CreateSecretResult,
  type CreateSecretStorePayload,
  type DeleteSecretStoreResult,
  type ImportSecretFromStorePayload,
  type SecretStoreCapabilities,
  type SecretStore as SecretStoreContract,
  type UpdateSecretStorePayload,
} from "./contracts";
import {
  ControlPlaneBadRequestError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
} from "../errors";
import {
  ExecutorPluginRegistryService,
  createManagedSecretStoreRecord,
  getManagedSecretStore,
  getSecretStoreContribution,
  listManagedSecretStores,
  removeManagedSecretStoreRecord,
  saveManagedSecretStoreRecord,
} from "../runtime";
import {
  ExecutorStateStore,
} from "../runtime/executor-state-store";
import {
  requireRuntimeLocalScope,
} from "../runtime/scope/runtime-context";
import type {
  SecretMaterial,
  SecretMaterialPurpose,
  SecretStore,
} from "../schema";
import {
  SecretMaterialIdSchema,
} from "../schema";

const secretStoreStorageError = (operation: string, message: string) =>
  new ControlPlaneStorageError({
    operation,
    message,
    details: message,
  });

const buildPluginHost = (scopeId: SecretStore["scopeId"]) => ({
  secretStores: {
    create: ({
      store,
    }: {
      store: Omit<
        SecretStore,
        "id" | "scopeId" | "createdAt" | "updatedAt"
      >;
    }) =>
      createManagedSecretStoreRecord({
        scopeId,
        store,
      }),
    get: (storeId: SecretStore["id"]) =>
      getManagedSecretStore(storeId),
    save: (store: SecretStore) =>
      saveManagedSecretStoreRecord(store),
    remove: (storeId: SecretStore["id"]) =>
      removeManagedSecretStoreRecord(storeId),
  },
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const getSecretStoreContributionOption = (kind: string) =>
  Effect.gen(function* () {
    const pluginRegistry = yield* ExecutorPluginRegistryService;
    try {
      return Option.some(getSecretStoreContribution(pluginRegistry, kind));
    } catch {
      return Option.none<any>();
    }
  });

const defaultCapabilities: SecretStoreCapabilities = {
  canCreateSecrets: false,
  canUpdateSecrets: false,
  canDeleteSecrets: false,
  canBrowseSecrets: false,
  canImportSecrets: false,
};

const loadStoreCapabilities = (
  store: SecretStore,
)=>
  Effect.gen(function* () {
    const contribution = yield* getSecretStoreContributionOption(store.kind);
    if (Option.isNone(contribution)) {
      return defaultCapabilities;
    }

    return yield* contribution.value.getCapabilities({
      store,
    }).pipe(
      Effect.mapError(() =>
        secretStoreStorageError(
          "secretStores.capabilities",
          `Failed loading capabilities for secret store ${store.id}.`,
        ),
      ),
    );
  });

const toSecretStoreContract = (
  store: SecretStore,
)=>
  Effect.map(loadStoreCapabilities(store), (capabilities) => ({
    ...store,
    capabilities,
  }));

const createImportedSecretRecord = (input: {
  store: SecretStore;
  secretStored: unknown;
  name: string | null;
  purpose: SecretMaterialPurpose;
}) =>
  Effect.gen(function* () {
    const executorState = yield* ExecutorStateStore;
    const now = Date.now();
    const material: SecretMaterial = {
      id: SecretMaterialIdSchema.make(`sec_${crypto.randomUUID()}`),
      storeId: input.store.id,
      name: input.name,
      purpose: input.purpose,
      createdAt: now,
      updatedAt: now,
    };

    yield* executorState.secretMaterials.upsert(material);
    yield* executorState.secretMaterialStoredData.upsert({
      secretId: material.id,
      data: input.secretStored,
    });

    return {
      id: material.id,
      name: material.name,
      storeId: material.storeId,
      purpose: material.purpose,
      createdAt: material.createdAt,
      updatedAt: material.updatedAt,
    } satisfies CreateSecretResult;
  });

export const listLocalSecretStores = () =>
  Effect.gen(function* () {
    const stores = yield* listManagedSecretStores().pipe(
      Effect.mapError(() =>
        secretStoreStorageError(
          "secretStores.list",
          "Failed listing secret stores.",
        ),
      ),
    );

    return yield* Effect.forEach(
      stores,
      (store) => toSecretStoreContract(store as SecretStore),
      {
        concurrency: 1,
      },
    );
  });

export const createLocalSecretStore = (payload: CreateSecretStorePayload) =>
  Effect.gen(function* () {
    const runtimeLocalScope = yield* requireRuntimeLocalScope().pipe(
      Effect.mapError(() =>
        secretStoreStorageError(
          "secretStores.create",
          "Failed resolving local scope.",
        ),
      ),
    );
    const pluginRegistry = yield* ExecutorPluginRegistryService;
    const contribution = yield* Effect.try({
      try: () => getSecretStoreContribution(pluginRegistry, payload.kind),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }).pipe(
      Effect.mapError((cause) =>
        secretStoreStorageError(
          "secretStores.create",
          cause.message,
        ),
      ),
    );
    if (!contribution.canCreate || !contribution.createStore) {
      return yield* new ControlPlaneBadRequestError({
        operation: "secretStores.create",
        message: `Secret store kind '${payload.kind}' cannot be created manually.`,
        details: `Secret store kind '${payload.kind}' cannot be created manually.`,
      });
    }

    const configRecord = asRecord(payload.config);
    if (configRecord === null) {
      return yield* new ControlPlaneBadRequestError({
        operation: "secretStores.create",
        message: "Secret store config must be an object.",
        details: "Secret store config must be an object.",
      });
    }

    const created = yield* contribution.createStore!({
      args: {
        kind: payload.kind,
        name: payload.name,
        ...configRecord,
      },
      host: buildPluginHost(runtimeLocalScope.installation.scopeId),
    }).pipe(
      Effect.mapError((cause) =>
        secretStoreStorageError(
          "secretStores.create",
          cause instanceof Error ? cause.message : "Failed creating secret store.",
        ),
      ),
    );

    return yield* toSecretStoreContract(created);
  });

export const updateLocalSecretStore = (input: {
  storeId: string;
  payload: UpdateSecretStorePayload;
}) =>
  Effect.gen(function* () {
    const runtimeLocalScope = yield* requireRuntimeLocalScope().pipe(
      Effect.mapError(() =>
        secretStoreStorageError(
          "secretStores.update",
          "Failed resolving local scope.",
        ),
      ),
    );
    const store = yield* getManagedSecretStore(input.storeId as SecretStore["id"]).pipe(
      Effect.mapError(() =>
        new ControlPlaneNotFoundError({
          operation: "secretStores.update",
          message: `Secret store not found: ${input.storeId}`,
          details: `Secret store not found: ${input.storeId}`,
        }),
      ),
    );

    const contribution = yield* getSecretStoreContributionOption(store.kind);
    const configRecord = input.payload.config === undefined
      ? null
      : asRecord(input.payload.config);

    let updated = store;
    if (configRecord !== null) {
      if (Option.isNone(contribution)) {
        return yield* new ControlPlaneBadRequestError({
          operation: "secretStores.update",
          message: `Secret store kind '${store.kind}' does not support config updates.`,
          details: `Secret store kind '${store.kind}' does not support config updates.`,
        });
      }

      updated = yield* contribution.value.updateStore({
        store,
        config: configRecord,
        host: buildPluginHost(runtimeLocalScope.installation.scopeId),
      }).pipe(
        Effect.mapError((cause) =>
          secretStoreStorageError(
            "secretStores.update",
            cause instanceof Error ? cause.message : "Failed updating secret store config.",
          ),
        ),
      );
    } else if (input.payload.config !== undefined) {
      return yield* new ControlPlaneBadRequestError({
        operation: "secretStores.update",
        message: "Secret store config must be an object.",
        details: "Secret store config must be an object.",
      });
    }

    if (input.payload.name !== undefined) {
      updated = yield* saveManagedSecretStoreRecord({
        ...updated,
        name: input.payload.name.trim() || updated.name,
      }).pipe(
        Effect.mapError(() =>
          secretStoreStorageError(
            "secretStores.update",
            "Failed saving secret store name.",
          ),
        ),
      );
    }

    return yield* toSecretStoreContract(updated);
  });

export const deleteLocalSecretStore = (storeId: string) =>
  Effect.gen(function* () {
    const executorState = yield* ExecutorStateStore;
    const store = yield* executorState.secretStores.getById(storeId as SecretStore["id"]);
    if (Option.isNone(store)) {
      return yield* new ControlPlaneNotFoundError({
        operation: "secretStores.delete",
        message: `Secret store not found: ${storeId}`,
        details: `Secret store not found: ${storeId}`,
      });
    }

    const contribution = yield* getSecretStoreContributionOption(store.value.kind);
    if (Option.isNone(contribution)) {
      return yield* new ControlPlaneBadRequestError({
        operation: "secretStores.delete",
        message: `Secret store kind '${store.value.kind}' cannot be removed.`,
        details: `Secret store kind '${store.value.kind}' cannot be removed.`,
      });
    }

    const removed = yield* contribution.value.removeStore({
      store: store.value,
      host: buildPluginHost(store.value.scopeId),
    }).pipe(
      Effect.mapError((cause) =>
        secretStoreStorageError(
          "secretStores.delete",
          cause instanceof Error ? cause.message : "Failed removing secret store.",
        ),
      ),
    );

    return {
      removed,
    } satisfies DeleteSecretStoreResult;
  });

export const browseLocalSecretStore = (input: {
  storeId: string;
  payload: BrowseSecretStorePayload;
}) =>
  Effect.gen(function* () {
    const store = yield* getManagedSecretStore(input.storeId as SecretStore["id"]).pipe(
      Effect.mapError(() =>
        new ControlPlaneNotFoundError({
          operation: "secretStores.browse",
          message: `Secret store not found: ${input.storeId}`,
          details: `Secret store not found: ${input.storeId}`,
        }),
      ),
    );

    const contribution = yield* getSecretStoreContributionOption(store.kind);
    const capabilities = yield* loadStoreCapabilities(store);
    if (Option.isNone(contribution) || !capabilities.canBrowseSecrets) {
      return yield* new ControlPlaneBadRequestError({
        operation: "secretStores.browse",
        message: `Secret store kind '${store.kind}' does not support browsing secrets.`,
        details: `Secret store kind '${store.kind}' does not support browsing secrets.`,
      });
    }

    return yield* contribution.value.browseSecrets({
      store,
      parentKey: input.payload.parentKey,
      query: input.payload.query,
    }).pipe(
      Effect.mapError((cause) =>
        secretStoreStorageError(
          "secretStores.browse",
          cause instanceof Error ? cause.message : "Failed browsing secret store.",
        ),
      ),
      Effect.map((result) => result as BrowseSecretStoreResult),
    );
  });

export const importLocalSecretFromStore = (input: {
  storeId: string;
  payload: ImportSecretFromStorePayload;
}) =>
  Effect.gen(function* () {
    const store = yield* getManagedSecretStore(input.storeId as SecretStore["id"]).pipe(
      Effect.mapError(() =>
        new ControlPlaneNotFoundError({
          operation: "secretStores.import",
          message: `Secret store not found: ${input.storeId}`,
          details: `Secret store not found: ${input.storeId}`,
        }),
      ),
    );

    const contribution = yield* getSecretStoreContributionOption(store.kind);
    if (Option.isNone(contribution)) {
      return yield* new ControlPlaneBadRequestError({
        operation: "secretStores.import",
        message: `Secret store kind '${store.kind}' does not support importing secrets.`,
        details: `Secret store kind '${store.kind}' does not support importing secrets.`,
      });
    }

    const capabilities = yield* loadStoreCapabilities(store);
    if (!capabilities.canImportSecrets) {
      return yield* new ControlPlaneBadRequestError({
        operation: "secretStores.import",
        message: `Secret store kind '${store.kind}' does not support importing secrets.`,
        details: `Secret store kind '${store.kind}' does not support importing secrets.`,
      });
    }

    const created = yield* contribution.value.importSecret({
      store,
      selectionKey: input.payload.selectionKey,
      purpose: input.payload.purpose ?? "auth_material",
      name: input.payload.name?.trim() || null,
    }).pipe(
      Effect.mapError((cause) =>
        secretStoreStorageError(
          "secretStores.import",
          cause instanceof Error ? cause.message : "Failed importing secret from store.",
        ),
      ),
    );

    return yield* createImportedSecretRecord({
      store,
      secretStored: created.secretStored,
      name: created.name,
      purpose: input.payload.purpose ?? "auth_material",
    });
  });
