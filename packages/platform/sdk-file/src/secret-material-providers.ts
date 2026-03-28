import { randomUUID } from "node:crypto";

import type {
  InstanceConfig,
  SecretProvider,
} from "@executor/platform-sdk/contracts";
import type {
  SecretMaterial,
  SecretMaterialPurpose,
  SecretRef,
  SecretStore,
  SecretStoreId,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  getSecretStoreContribution,
  registeredSecretStoreContributions,
  LocalInstanceConfigService,
  runtimeEffectError,
  SecretMaterialDeleterService,
  SecretMaterialResolverService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
  type DeleteSecretMaterial,
  type ExecutorStateStoreShape,
  type ResolveInstanceConfig,
  type ResolveSecretMaterial,
  type StoreSecretMaterial,
  type UpdateSecretMaterial,
} from "@executor/platform-sdk/runtime";

const SECRET_STORE_KIND_ENV = "EXECUTOR_SECRET_STORE_PROVIDER";

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const builtinSecretStoreContributions = () =>
  registeredSecretStoreContributions()
    .filter((entry) => entry.builtin !== undefined)
    .filter((entry) => entry.builtin?.enabled?.() ?? true)
    .map((entry) => ({
      contribution: entry,
      builtin: entry.builtin!,
    }));

const resolveStoreContribution = (store: SecretStore) =>
  getSecretStoreContribution(store.kind);

const loadStoreCapabilities = (store: SecretStore) =>
  resolveStoreContribution(store).getCapabilities({
    store,
  }) as Effect.Effect<{
    canCreateSecrets: boolean;
    canUpdateSecrets: boolean;
    canDeleteSecrets: boolean;
    canBrowseSecrets: boolean;
    canImportSecrets: boolean;
  }, Error, never>;

const parseDefaultStoreKind = (value: string | undefined): string | null => {
  const normalized = trimOrNull(value)?.toLowerCase();
  return normalized ?? null;
};

const resolveDefaultStoreId = (
  stores: ReadonlyArray<{
    id: string;
    kind: string;
  }>,
): SecretStoreId | null => {
  const explicitKind = parseDefaultStoreKind(process.env[SECRET_STORE_KIND_ENV]);
  if (explicitKind) {
    const explicitStore = stores.find((store) => store.kind === explicitKind);
    if (explicitStore) {
      return explicitStore.id as SecretStoreId;
    }
  }

  const prioritizedBuiltins = builtinSecretStoreContributions()
    .sort((left, right) =>
      (right.builtin.defaultPriority ?? 0) - (left.builtin.defaultPriority ?? 0)
    );

  for (const entry of prioritizedBuiltins) {
    const builtinStore = stores.find((store) => store.id === entry.builtin.storeId);
    if (builtinStore) {
      return builtinStore.id as SecretStoreId;
    }
  }

  return (stores[0]?.id as SecretStoreId | undefined) ?? null;
};

export const provisionBuiltinSecretStores = (input: {
  executorState: ExecutorStateStoreShape;
  scopeId: string;
}) =>
  Effect.gen(function* () {
    const now = Date.now();

    for (const entry of builtinSecretStoreContributions()) {
      const existing = yield* input.executorState.secretStores.getById(
        entry.builtin.storeId as SecretStore["id"],
      );
      if (Option.isSome(existing)) {
        continue;
      }

      yield* input.executorState.secretStores.upsert({
        id: entry.builtin.storeId as SecretStoreId,
        scopeId: input.scopeId as SecretStore["scopeId"],
        ...entry.builtin.createStore(),
        createdAt: now,
        updatedAt: now,
      });
    }
  });

const loadMaterialByRef = (input: {
  executorState: ExecutorStateStoreShape;
  ref: SecretRef;
}) =>
  Effect.gen(function* () {
    const material = yield* input.executorState.secretMaterials.getById(
      input.ref.secretId,
    );
    if (Option.isNone(material)) {
      return yield* runtimeEffectError(
        "local/secret-material-providers",
        `Secret not found: ${input.ref.secretId}`,
      );
    }

    return material.value;
  });

const loadStoreById = (input: {
  executorState: ExecutorStateStoreShape;
  storeId: SecretStore["id"];
}) =>
  Effect.gen(function* () {
    const store = yield* input.executorState.secretStores.getById(input.storeId);
    if (Option.isNone(store)) {
      return yield* runtimeEffectError(
        "local/secret-material-providers",
        `Secret store not found: ${input.storeId}`,
      );
    }

    return store.value;
  });

const provideSecretResolver = <A, E>(
  effect: Effect.Effect<A, E, any>,
  resolveSecretMaterial: ResolveSecretMaterial,
): Effect.Effect<A, E, never> =>
  effect.pipe(
    Effect.provideService(SecretMaterialResolverService, resolveSecretMaterial),
  ) as Effect.Effect<A, E, never>;

export const createDefaultSecretMaterialResolver = (input: {
  executorState: ExecutorStateStoreShape;
  keychainServiceName?: string;
}): ResolveSecretMaterial => {
  let resolveSecretMaterial!: ResolveSecretMaterial;
  resolveSecretMaterial = ({ ref, context }) =>
    Effect.gen(function* () {
      const material = yield* loadMaterialByRef({
        executorState: input.executorState,
        ref,
      });
      const store = yield* loadStoreById({
        executorState: input.executorState,
        storeId: material.storeId,
      });
      const contribution = resolveStoreContribution(store);
      return yield* provideSecretResolver(
        contribution.resolveSecret({
          secret: material,
          store,
          context,
        }),
        resolveSecretMaterial,
      );
    });

  return resolveSecretMaterial;
};

export const createDefaultSecretMaterialStorer = (input: {
  executorState: ExecutorStateStoreShape;
  resolveSecretMaterial: ResolveSecretMaterial;
  keychainServiceName?: string;
}): StoreSecretMaterial => {
  return ({ purpose, value, name, storeId }) =>
    Effect.gen(function* () {
      const stores = yield* input.executorState.secretStores.listAll();
      const resolvedStoreId = storeId ?? resolveDefaultStoreId(stores);
      if (resolvedStoreId === null) {
        return yield* runtimeEffectError(
          "local/secret-material-providers",
          "No secret stores are registered in this runtime.",
        );
      }

      const store = yield* loadStoreById({
        executorState: input.executorState,
        storeId: resolvedStoreId as SecretStore["id"],
      });
      const contribution = resolveStoreContribution(store);

      const capabilities = yield* loadStoreCapabilities(store);
      if (!capabilities.canCreateSecrets) {
        return yield* runtimeEffectError(
          "local/secret-material-providers",
          `Secret store ${store.id} does not support creating secrets`,
        );
      }

      const created = yield* provideSecretResolver(
        contribution.createSecret({
          store,
          purpose,
          value,
          name,
        }),
        input.resolveSecretMaterial,
      );

      const now = Date.now();
      const material: SecretMaterial = {
        id: `sec_${randomUUID()}` as SecretMaterial["id"],
        storeId: store.id,
        handle: created.handle,
        name: created.name,
        purpose,
        value: created.value ?? null,
        createdAt: now,
        updatedAt: now,
      };

      yield* input.executorState.secretMaterials.upsert(material);

      return {
        secretId: material.id,
      } satisfies SecretRef;
    });
};

export const createDefaultSecretMaterialUpdater = (input: {
  executorState: ExecutorStateStoreShape;
  resolveSecretMaterial: ResolveSecretMaterial;
  keychainServiceName?: string;
}): UpdateSecretMaterial => {
  return ({ ref, name, value }) =>
    Effect.gen(function* () {
      const material = yield* loadMaterialByRef({
        executorState: input.executorState,
        ref,
      });
      const store = yield* loadStoreById({
        executorState: input.executorState,
        storeId: material.storeId,
      });
      const contribution = resolveStoreContribution(store);

      const capabilities = yield* loadStoreCapabilities(store);
      if (!capabilities.canUpdateSecrets) {
        return yield* runtimeEffectError(
          "local/secret-material-providers",
          `Secret store ${store.id} does not support updating secrets`,
        );
      }

      const updated = yield* provideSecretResolver(
        contribution.updateSecret({
          secret: material,
          store,
          name,
          value,
        }),
        input.resolveSecretMaterial,
      );

      const nextMaterial: SecretMaterial = {
        ...material,
        ...(updated.handle ? { handle: updated.handle } : {}),
        name: updated.name,
        value: updated.value ?? material.value,
        updatedAt: Date.now(),
      };
      yield* input.executorState.secretMaterials.upsert(nextMaterial);

      return {
        id: nextMaterial.id,
        storeId: nextMaterial.storeId,
        name: nextMaterial.name,
        purpose: nextMaterial.purpose,
        createdAt: nextMaterial.createdAt,
        updatedAt: nextMaterial.updatedAt,
      };
    });
};

export const createDefaultSecretMaterialDeleter = (input: {
  executorState: ExecutorStateStoreShape;
  resolveSecretMaterial: ResolveSecretMaterial;
  keychainServiceName?: string;
}): DeleteSecretMaterial => {
  return (ref) =>
    Effect.gen(function* () {
      const material = yield* loadMaterialByRef({
        executorState: input.executorState,
        ref,
      });
      const store = yield* loadStoreById({
        executorState: input.executorState,
        storeId: material.storeId,
      });
      const contribution = resolveStoreContribution(store);
      const capabilities = yield* loadStoreCapabilities(store);
      const deleted = capabilities.canDeleteSecrets
        ? yield* provideSecretResolver(
            contribution.deleteSecret({
              secret: material,
              store,
            }),
            input.resolveSecretMaterial,
          )
        : false;

      if (!deleted) {
        return false;
      }

      return yield* input.executorState.secretMaterials.removeById(material.id);
    });
};

const listAvailableSecretStorePlugins = (): SecretProvider[] => {
  return registeredSecretStoreContributions().map((entry) => ({
    kind: entry.kind,
    displayName: entry.displayName,
    canCreate: entry.canCreate,
  }));
};

export const createLocalInstanceConfigResolver = (input: {
  executorState: ExecutorStateStoreShape;
}): ResolveInstanceConfig => () =>
  Effect.gen(function* () {
    const stores = yield* input.executorState.secretStores.listAll();
    return {
      platform: process.platform,
      secretStorePlugins: listAvailableSecretStorePlugins(),
      defaultSecretStoreId: resolveDefaultStoreId(stores),
    } satisfies InstanceConfig;
  });

export const SecretMaterialResolverLive = (input: {
  executorState: ExecutorStateStoreShape;
  resolveSecretMaterial?: ResolveSecretMaterial;
  keychainServiceName?: string;
}) =>
  input.resolveSecretMaterial
    ? Layer.succeed(SecretMaterialResolverService, input.resolveSecretMaterial)
    : Layer.succeed(
        SecretMaterialResolverService,
        createDefaultSecretMaterialResolver(input),
      );

export const SecretMaterialStorerLive = (input: {
  executorState: ExecutorStateStoreShape;
  resolveSecretMaterial: ResolveSecretMaterial;
  keychainServiceName?: string;
}) =>
  Layer.succeed(
    SecretMaterialStorerService,
    createDefaultSecretMaterialStorer(input),
  );

export const SecretMaterialDeleterLive = (input: {
  executorState: ExecutorStateStoreShape;
  resolveSecretMaterial: ResolveSecretMaterial;
  keychainServiceName?: string;
}) =>
  Layer.succeed(
    SecretMaterialDeleterService,
    createDefaultSecretMaterialDeleter(input),
  );

export const SecretMaterialUpdaterLive = (input: {
  executorState: ExecutorStateStoreShape;
  resolveSecretMaterial: ResolveSecretMaterial;
  keychainServiceName?: string;
}) =>
  Layer.succeed(
    SecretMaterialUpdaterService,
    createDefaultSecretMaterialUpdater(input),
  );

export const SecretMaterialLive = (input: {
  executorState: ExecutorStateStoreShape;
  resolveSecretMaterial?: ResolveSecretMaterial;
  keychainServiceName?: string;
}) =>
  Layer.mergeAll(
    SecretMaterialResolverLive(input),
    SecretMaterialStorerLive({
      executorState: input.executorState,
      resolveSecretMaterial:
        input.resolveSecretMaterial
        ?? createDefaultSecretMaterialResolver({
          executorState: input.executorState,
          keychainServiceName: input.keychainServiceName,
        }),
      keychainServiceName: input.keychainServiceName,
    }),
    SecretMaterialDeleterLive({
      executorState: input.executorState,
      resolveSecretMaterial:
        input.resolveSecretMaterial
        ?? createDefaultSecretMaterialResolver({
          executorState: input.executorState,
          keychainServiceName: input.keychainServiceName,
        }),
      keychainServiceName: input.keychainServiceName,
    }),
    SecretMaterialUpdaterLive({
      executorState: input.executorState,
      resolveSecretMaterial:
        input.resolveSecretMaterial
        ?? createDefaultSecretMaterialResolver({
          executorState: input.executorState,
          keychainServiceName: input.keychainServiceName,
        }),
      keychainServiceName: input.keychainServiceName,
    }),
  );

export const LocalInstanceConfigLive = (input: {
  executorState: ExecutorStateStoreShape;
}) =>
  Layer.succeed(
    LocalInstanceConfigService,
    createLocalInstanceConfigResolver(input),
  );
