import * as Effect from "effect/Effect";

import type { SourceCatalogSyncResult } from "@executor/source-core";
import type {
  SourceCatalogKind,
} from "@executor/source-core";
import type { ExecutorEffect } from "./executor-effect";
import type { ExecutorScopeContext } from "./scope";
import type {
  Source as ExecutorSource,
  SecretMaterial,
  SecretMaterialPurpose,
  SecretRef,
  SecretStore,
} from "./schema";
import type {
  SourceInvokeInput,
  SourceInvokeResult,
} from "@executor/source-core";
import type * as Schema from "effect/Schema";
import { runtimeEffectError } from "./runtime/effect-errors";

export type PluginCleanup = {
  close: () => void | Promise<void>;
};

export type ExecutorSdkPluginHost = {};

export type ExecutorSdkPluginContext = {
  executor: ExecutorEffect & Record<string, unknown>;
  scope: ExecutorScopeContext;
  host: ExecutorSdkPluginHost;
};

export type ExecutorSdkPluginStartContext<
  TExtension extends object = {},
> = ExecutorSdkPluginContext & {
  extension: TExtension;
};

type ExecutorSdkPluginInternals = {
  sources?: readonly ExecutorSourceContribution<any>[];
  secretStores?: readonly ExecutorSecretStoreContribution<any>[];
};

const executorSdkPluginInternalsSymbol = Symbol.for(
  "@executor/platform-sdk/plugins/internals",
);

type ExecutorSdkPluginInternalCarrier = {
  [executorSdkPluginInternalsSymbol]?: ExecutorSdkPluginInternals;
};

export type ExecutorSdkPlugin<
  TKey extends string = string,
  TExtension extends object = {},
> = {
  key: TKey;
  extendExecutor?: (input: ExecutorSdkPluginContext) => TExtension;
  start?: (
    input: ExecutorSdkPluginStartContext<TExtension>,
  ) => Effect.Effect<PluginCleanup | void, Error, any>;
} & ExecutorSdkPluginInternalCarrier;

export const defineExecutorSdkPlugin = <
  const TPlugin extends ExecutorSdkPlugin<any, any>,
>(
  plugin: TPlugin,
): TPlugin => plugin;

type ExecutorSourcePluginInternalHost = {
  sources: {
    create: (input: {
      source: Omit<
        ExecutorSource,
        "id" | "scopeId" | "createdAt" | "updatedAt"
      >;
    }) => Effect.Effect<ExecutorSource, Error, any>;
    get: (sourceId: ExecutorSource["id"]) => Effect.Effect<ExecutorSource, Error, any>;
    save: (source: ExecutorSource) => Effect.Effect<ExecutorSource, Error, any>;
    refreshCatalog: (
      sourceId: ExecutorSource["id"],
    ) => Effect.Effect<ExecutorSource, Error, any>;
    remove: (sourceId: ExecutorSource["id"]) => Effect.Effect<boolean, Error, any>;
  };
};

type ExecutorSecretStorePluginInternalHost = {
  secretStores: {
    create: (input: {
      store: Omit<
        SecretStore,
        "id" | "scopeId" | "createdAt" | "updatedAt"
      >;
    }) => Effect.Effect<SecretStore, Error, any>;
    get: (storeId: SecretStore["id"]) => Effect.Effect<SecretStore, Error, any>;
    save: (store: SecretStore) => Effect.Effect<SecretStore, Error, any>;
    remove: (storeId: SecretStore["id"]) => Effect.Effect<boolean, Error, any>;
  };
};

export type ExecutorSourcePluginStorage<TStored> = {
  get: (input: {
    scopeId: ExecutorSource["scopeId"];
    sourceId: ExecutorSource["id"];
  }) => Effect.Effect<TStored | null, Error, any>;
  put: (input: {
    scopeId: ExecutorSource["scopeId"];
    sourceId: ExecutorSource["id"];
    value: TStored;
  }) => Effect.Effect<void, Error, any>;
  remove?: (input: {
    scopeId: ExecutorSource["scopeId"];
    sourceId: ExecutorSource["id"];
  }) => Effect.Effect<void, Error, any>;
};

export type ExecutorSecretStorePluginStorage<TStored> = {
  get: (input: {
    scopeId: SecretStore["scopeId"];
    storeId: SecretStore["id"];
  }) => Effect.Effect<TStored | null, Error, any>;
  put: (input: {
    scopeId: SecretStore["scopeId"];
    storeId: SecretStore["id"];
    value: TStored;
  }) => Effect.Effect<void, Error, any>;
  remove?: (input: {
    scopeId: SecretStore["scopeId"];
    storeId: SecretStore["id"];
  }) => Effect.Effect<void, Error, any>;
};

export type ExecutorSourcePluginApi<
  TConnectInput,
  TSourceConfig,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
> = {
  getSource: (
    sourceId: ExecutorSource["id"],
  ) => Effect.Effect<ExecutorSource, Error, any>;
  getSourceConfig: (
    sourceId: ExecutorSource["id"],
  ) => Effect.Effect<TSourceConfig, Error, any>;
  createSource: (
    input: TConnectInput,
  ) => Effect.Effect<ExecutorSource, Error, any>;
  updateSource: (
    input: TUpdateInput,
  ) => Effect.Effect<ExecutorSource, Error, any>;
  refreshSource: (
    sourceId: ExecutorSource["id"],
  ) => Effect.Effect<ExecutorSource, Error, any>;
  removeSource: (
    sourceId: ExecutorSource["id"],
  ) => Effect.Effect<boolean, Error, any>;
};

export type ExecutorSecretStorePluginApi<
  TConnectInput,
  TStoreConfig,
  TUpdateInput extends {
    storeId: string;
    config: TStoreConfig;
  },
> = {
  getStore: (
    storeId: SecretStore["id"],
  ) => Effect.Effect<SecretStore, Error, any>;
  getStoreConfig: (
    storeId: SecretStore["id"],
  ) => Effect.Effect<TStoreConfig, Error, any>;
  createStore: (
    input: TConnectInput,
  ) => Effect.Effect<SecretStore, Error, any>;
  updateStore: (
    input: TUpdateInput,
  ) => Effect.Effect<SecretStore, Error, any>;
  removeStore: (
    storeId: SecretStore["id"],
  ) => Effect.Effect<boolean, Error, any>;
};

export type ExecutorSourcePluginDefinition<
  TAddInput,
  TConnectInput,
  TSourceConfig,
  TStored,
  _TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
> = {
  kind: string;
  displayName: string;
  add: {
    inputSchema: Schema.Schema<TAddInput, any, never>;
    inputSignatureWidth?: number;
    helpText?: readonly string[];
    toConnectInput: (input: TAddInput) => TConnectInput;
  };
  storage: ExecutorSourcePluginStorage<TStored>;
  source: {
    create: (input: TConnectInput) => {
      source: Omit<
        ExecutorSource,
        "id" | "scopeId" | "createdAt" | "updatedAt"
      >;
      stored: TStored;
    };
    update: (input: {
      source: ExecutorSource;
      config: TSourceConfig;
    }) => {
      source: ExecutorSource;
      stored: TStored;
    };
    toConfig: (input: {
      source: ExecutorSource;
      stored: TStored;
    }) => TSourceConfig;
    remove?: (input: {
      source: ExecutorSource;
      stored: TStored | null;
    }) => Effect.Effect<void, Error, any>;
  };
  catalog: {
    kind: SourceCatalogKind;
    identity?: (input: {
      source: ExecutorSource;
    }) => Record<string, unknown>;
    sync: (input: {
      source: ExecutorSource;
      stored: TStored | null;
    }) => Effect.Effect<SourceCatalogSyncResult, Error, any>;
    invoke: (
      input: SourceInvokeInput & {
        source: ExecutorSource;
        stored: TStored | null;
      },
    ) => Effect.Effect<SourceInvokeResult, Error, any>;
  };
};

export type ExecutorSecretStorePluginCapabilities = {
  canCreateSecrets: boolean;
  canUpdateSecrets: boolean;
  canDeleteSecrets: boolean;
  canBrowseSecrets: boolean;
  canImportSecrets: boolean;
};

export type ExecutorSecretStoreBrowseEntry = {
  key: string;
  label: string;
  description: string | null;
  kind: "group" | "secret";
};

export type ExecutorSecretStoreBuiltinDefinition = {
  storeId: string;
  defaultPriority?: number;
  enabled?: () => boolean;
  createStore: () => Omit<
    SecretStore,
    "id" | "scopeId" | "createdAt" | "updatedAt"
  >;
};

export type ExecutorSecretStorePluginDefinition<
  TAddInput,
  TConnectInput,
  TStoreConfig,
  TStored,
  _TUpdateInput extends {
    storeId: string;
    config: TStoreConfig;
  },
> = {
  kind: string;
  displayName: string;
  builtin?: ExecutorSecretStoreBuiltinDefinition;
  add?: {
    inputSchema: Schema.Schema<TAddInput, any, never>;
    inputSignatureWidth?: number;
    helpText?: readonly string[];
    toConnectInput: (input: TAddInput) => TConnectInput;
  };
  storage: ExecutorSecretStorePluginStorage<TStored>;
  store: {
    create: (input: TConnectInput) => {
      store: Omit<
        SecretStore,
        "id" | "scopeId" | "createdAt" | "updatedAt"
      >;
      stored: TStored;
    };
    update: (input: {
      store: SecretStore;
      config: TStoreConfig;
    }) => {
      store: SecretStore;
      stored: TStored;
    };
    toConfig: (input: {
      store: SecretStore;
      stored: TStored;
    }) => TStoreConfig;
    remove?: (input: {
      store: SecretStore;
      stored: TStored | null;
    }) => Effect.Effect<void, Error, any>;
    resolveSecret: (input: {
      secret: SecretMaterial;
      store: SecretStore;
      stored: TStored | null;
      context?: {
        params?: Readonly<Record<string, string | undefined>>;
      };
    }) => Effect.Effect<string, Error, any>;
    createSecret?: (input: {
      store: SecretStore;
      stored: TStored | null;
      purpose: SecretMaterialPurpose;
      value: string;
      name?: string | null;
    }) => Effect.Effect<{
      handle: string;
      name: string | null;
      value?: string | null;
    }, Error, any>;
    updateSecret?: (input: {
      secret: SecretMaterial;
      store: SecretStore;
      stored: TStored | null;
      name?: string | null;
      value?: string;
    }) => Effect.Effect<{
      handle?: string;
      name: string | null;
      value?: string | null;
    }, Error, any>;
    deleteSecret?: (input: {
      secret: SecretMaterial;
      store: SecretStore;
      stored: TStored | null;
    }) => Effect.Effect<boolean, Error, any>;
    browseSecrets?: (input: {
      store: SecretStore;
      stored: TStored | null;
      parentKey?: string | null;
      query?: string | null;
    }) => Effect.Effect<{
      entries: ReadonlyArray<ExecutorSecretStoreBrowseEntry>;
    }, Error, any>;
    importSecret?: (input: {
      store: SecretStore;
      stored: TStored | null;
      selectionKey: string;
      purpose: SecretMaterialPurpose;
      name?: string | null;
    }) => Effect.Effect<{
      handle: string;
      name: string | null;
      value?: string | null;
    }, Error, any>;
    capabilities?: (input: {
      store: SecretStore;
      stored: TStored | null;
    }) => ExecutorSecretStorePluginCapabilities;
  };
};

export type ExecutorSourcePluginInput<
  TKey extends string = string,
  TAddInput = unknown,
  TConnectInput = unknown,
  TSourceConfig = unknown,
  TStored = unknown,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  } = {
    sourceId: string;
    config: TSourceConfig;
  },
  TExtension extends object = {},
> = {
  key: TKey;
  source: ExecutorSourcePluginDefinition<
    TAddInput,
    TConnectInput,
    TSourceConfig,
    TStored,
    TUpdateInput
  >;
  extendExecutor?: (input: ExecutorSdkPluginContext & {
    source: ExecutorSourcePluginApi<TConnectInput, TSourceConfig, TUpdateInput>;
  }) => TExtension;
  start?: (
    input: ExecutorSdkPluginStartContext<TExtension> & {
      source: ExecutorSourcePluginApi<
        TConnectInput,
        TSourceConfig,
        TUpdateInput
      >;
    },
  ) => Effect.Effect<PluginCleanup | void, Error, any>;
};

export type ExecutorSecretStorePluginInput<
  TKey extends string = string,
  TAddInput = unknown,
  TConnectInput = unknown,
  TStoreConfig = unknown,
  TStored = unknown,
  TUpdateInput extends {
    storeId: string;
    config: TStoreConfig;
  } = {
    storeId: string;
    config: TStoreConfig;
  },
  TExtension extends object = {},
> = {
  key: TKey;
  secretStore: ExecutorSecretStorePluginDefinition<
    TAddInput,
    TConnectInput,
    TStoreConfig,
    TStored,
    TUpdateInput
  >;
  extendExecutor?: (input: ExecutorSdkPluginContext & {
    secretStore: ExecutorSecretStorePluginApi<TConnectInput, TStoreConfig, TUpdateInput>;
  }) => TExtension;
  start?: (
    input: ExecutorSdkPluginStartContext<TExtension> & {
      secretStore: ExecutorSecretStorePluginApi<
        TConnectInput,
        TStoreConfig,
        TUpdateInput
      >;
    },
  ) => Effect.Effect<PluginCleanup | void, Error, any>;
};

const loadSourceOfKind = (
  sourceId: ExecutorSource["id"],
  input: {
    definition: ExecutorSourcePluginDefinition<any, any, any, any, any>;
    host: ExecutorSourcePluginInternalHost;
  },
): Effect.Effect<ExecutorSource, Error, any> =>
  Effect.gen(function* () {
    const source = yield* input.host.sources.get(sourceId);
    if (source.kind !== input.definition.kind) {
      return yield* runtimeEffectError(
        "plugins",
        `Source ${sourceId} is not a ${input.definition.displayName} source.`,
      );
    }

    return source;
  });

const createExecutorSourcePluginApi = <
  TAddInput,
  TConnectInput,
  TSourceConfig,
  TStored,
  _TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
>(
  definition: ExecutorSourcePluginDefinition<
    TAddInput,
    TConnectInput,
    TSourceConfig,
    TStored,
    _TUpdateInput
  >,
  host: ExecutorSourcePluginInternalHost,
): ExecutorSourcePluginApi<TConnectInput, TSourceConfig, _TUpdateInput> => ({
  getSource: (sourceId) =>
    loadSourceOfKind(sourceId, {
      definition,
      host,
    }),
  getSourceConfig: (sourceId) =>
    Effect.gen(function* () {
      const source = yield* loadSourceOfKind(sourceId, {
        definition,
        host,
      });
      const stored = yield* definition.storage.get({
        scopeId: source.scopeId,
        sourceId: source.id,
      });
      if (stored === null) {
        return yield* runtimeEffectError(
          "plugins",
          `${definition.displayName} source storage missing for ${source.id}`,
        );
      }

      return definition.source.toConfig({
        source,
        stored,
      });
    }),
  createSource: (input) =>
    Effect.gen(function* () {
      const created = definition.source.create(input);
      const source = yield* host.sources.create({
        source: created.source,
      });

      yield* definition.storage.put({
        scopeId: source.scopeId,
        sourceId: source.id,
        value: created.stored,
      });

      return yield* host.sources.refreshCatalog(source.id);
    }),
  updateSource: (input) =>
    Effect.gen(function* () {
      const source = yield* loadSourceOfKind(input.sourceId as ExecutorSource["id"], {
        definition,
        host,
      });
      const updated = definition.source.update({
        source,
        config: input.config,
      });
      const saved = yield* host.sources.save(updated.source);

      yield* definition.storage.put({
        scopeId: saved.scopeId,
        sourceId: saved.id,
        value: updated.stored,
      });

      return yield* host.sources.refreshCatalog(saved.id);
    }),
  refreshSource: (sourceId) =>
    Effect.gen(function* () {
      const source = yield* loadSourceOfKind(sourceId, {
        definition,
        host,
      });

      return yield* host.sources.refreshCatalog(source.id);
    }),
  removeSource: (sourceId) =>
    Effect.gen(function* () {
      const source = yield* loadSourceOfKind(sourceId, {
        definition,
        host,
      });
      const stored = yield* definition.storage.get({
        scopeId: source.scopeId,
        sourceId: source.id,
      });

      if (definition.source.remove) {
        yield* definition.source.remove({
          source,
          stored,
        });
      }

      if (definition.storage.remove) {
        yield* definition.storage.remove({
          scopeId: source.scopeId,
          sourceId: source.id,
        });
      }

      return yield* host.sources.remove(source.id);
    }),
});

const loadStoreOfKind = (
  storeId: SecretStore["id"],
  input: {
    definition: ExecutorSecretStorePluginDefinition<any, any, any, any, any>;
    host: ExecutorSecretStorePluginInternalHost;
  },
): Effect.Effect<SecretStore, Error, any> =>
  Effect.gen(function* () {
    const store = yield* input.host.secretStores.get(storeId);
    if (store.kind !== input.definition.kind) {
      return yield* runtimeEffectError(
        "plugins",
        `Secret store ${storeId} is not a ${input.definition.displayName} store.`,
      );
    }

    return store;
  });

const createExecutorSecretStorePluginApi = <
  TAddInput,
  TConnectInput,
  TStoreConfig,
  TStored,
  _TUpdateInput extends {
    storeId: string;
    config: TStoreConfig;
  },
>(
  definition: ExecutorSecretStorePluginDefinition<
    TAddInput,
    TConnectInput,
    TStoreConfig,
    TStored,
    _TUpdateInput
  >,
  host: ExecutorSecretStorePluginInternalHost,
): ExecutorSecretStorePluginApi<TConnectInput, TStoreConfig, _TUpdateInput> => ({
  getStore: (storeId) =>
    loadStoreOfKind(storeId, {
      definition,
      host,
    }),
  getStoreConfig: (storeId) =>
    Effect.gen(function* () {
      const store = yield* loadStoreOfKind(storeId, {
        definition,
        host,
      });
      const stored = yield* definition.storage.get({
        scopeId: store.scopeId,
        storeId: store.id,
      });
      if (stored === null) {
        return yield* runtimeEffectError(
          "plugins",
          `${definition.displayName} store storage missing for ${store.id}`,
        );
      }

      return definition.store.toConfig({
        store,
        stored,
      });
    }),
  createStore: (input) =>
    Effect.gen(function* () {
      const created = definition.store.create(input);
      const store = yield* host.secretStores.create({
        store: created.store,
      });

      yield* definition.storage.put({
        scopeId: store.scopeId,
        storeId: store.id,
        value: created.stored,
      });

      return store;
    }),
  updateStore: (input) =>
    Effect.gen(function* () {
      const store = yield* loadStoreOfKind(input.storeId as SecretStore["id"], {
        definition,
        host,
      });
      const updated = definition.store.update({
        store,
        config: input.config,
      });
      const saved = yield* host.secretStores.save(updated.store);

      yield* definition.storage.put({
        scopeId: saved.scopeId,
        storeId: saved.id,
        value: updated.stored,
      });

      return saved;
    }),
  removeStore: (storeId) =>
    Effect.gen(function* () {
      const store = yield* loadStoreOfKind(storeId, {
        definition,
        host,
      });
      const stored = yield* definition.storage.get({
        scopeId: store.scopeId,
        storeId: store.id,
      });

      if (definition.store.remove) {
        yield* definition.store.remove({
          store,
          stored,
        });
      }

      if (definition.storage.remove) {
        yield* definition.storage.remove({
          scopeId: store.scopeId,
          storeId: store.id,
        });
      }

      return yield* host.secretStores.remove(store.id);
    }),
});

type ExecutorSourceContribution<TInput = unknown> = {
  kind: string;
  displayName: string;
  inputSchema: Schema.Schema<TInput, any, never>;
  inputSignatureWidth?: number;
  helpText?: readonly string[];
  catalogKind: SourceCatalogKind;
  catalogIdentity?: (input: {
    source: ExecutorSource;
  }) => Record<string, unknown>;
  createSource: (input: {
    args: TInput;
    host: ExecutorSourcePluginInternalHost;
  }) => Effect.Effect<ExecutorSource, Error, any>;
  syncCatalog: (input: {
    source: ExecutorSource;
  }) => Effect.Effect<SourceCatalogSyncResult, Error, any>;
  invoke: (
    input: SourceInvokeInput & {
      source: ExecutorSource;
    },
  ) => Effect.Effect<SourceInvokeResult, Error, any>;
};

type ExecutorSecretStoreContribution<TInput = unknown> = {
  kind: string;
  displayName: string;
  builtin?: ExecutorSecretStoreBuiltinDefinition;
  canCreate: boolean;
  inputSchema?: Schema.Schema<TInput, any, never>;
  inputSignatureWidth?: number;
  helpText?: readonly string[];
  createStore?: (input: {
    args: TInput;
    host: ExecutorSecretStorePluginInternalHost;
  }) => Effect.Effect<SecretStore, Error, any>;
  getStoreConfig: (input: {
    store: SecretStore;
  }) => Effect.Effect<unknown, Error, any>;
  updateStore: (input: {
    store: SecretStore;
    config: unknown;
    host: ExecutorSecretStorePluginInternalHost;
  }) => Effect.Effect<SecretStore, Error, any>;
  removeStore: (input: {
    store: SecretStore;
    host: ExecutorSecretStorePluginInternalHost;
  }) => Effect.Effect<boolean, Error, any>;
  getCapabilities: (input: {
    store: SecretStore;
  }) => Effect.Effect<ExecutorSecretStorePluginCapabilities, Error, any>;
  resolveSecret: (input: {
    secret: SecretMaterial;
    store: SecretStore;
    context?: {
      params?: Readonly<Record<string, string | undefined>>;
    };
  }) => Effect.Effect<string, Error, any>;
  createSecret: (input: {
    store: SecretStore;
    purpose: SecretMaterialPurpose;
    value: string;
    name?: string | null;
  }) => Effect.Effect<{
    handle: string;
    name: string | null;
    value?: string | null;
  }, Error, any>;
  updateSecret: (input: {
    secret: SecretMaterial;
    store: SecretStore;
    name?: string | null;
    value?: string;
  }) => Effect.Effect<{
    handle?: string;
    name: string | null;
    value?: string | null;
  }, Error, any>;
  deleteSecret: (input: {
    secret: SecretMaterial;
    store: SecretStore;
  }) => Effect.Effect<boolean, Error, any>;
  browseSecrets: (input: {
    store: SecretStore;
    parentKey?: string | null;
    query?: string | null;
  }) => Effect.Effect<{
    entries: ReadonlyArray<ExecutorSecretStoreBrowseEntry>;
  }, Error, any>;
  importSecret: (input: {
    store: SecretStore;
    selectionKey: string;
    purpose: SecretMaterialPurpose;
    name?: string | null;
  }) => Effect.Effect<{
    handle: string;
    name: string | null;
    value?: string | null;
  }, Error, any>;
};

const createExecutorSourceContribution = <
  TAddInput,
  TConnectInput,
  TSourceConfig,
  TStored,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
>(
  definition: ExecutorSourcePluginDefinition<
    TAddInput,
    TConnectInput,
    TSourceConfig,
    TStored,
    TUpdateInput
  >,
): ExecutorSourceContribution<TAddInput> => ({
  kind: definition.kind,
  displayName: definition.displayName,
  inputSchema: definition.add.inputSchema,
  inputSignatureWidth: definition.add.inputSignatureWidth,
  helpText: definition.add.helpText,
  catalogKind: definition.catalog.kind,
  catalogIdentity: definition.catalog.identity,
  createSource: ({ args, host }) =>
    createExecutorSourcePluginApi(definition, host).createSource(
      definition.add.toConnectInput(args),
    ),
  syncCatalog: ({ source }) =>
    Effect.flatMap(
      definition.storage.get({
        scopeId: source.scopeId,
        sourceId: source.id,
      }),
      (stored) =>
        definition.catalog.sync({
          source,
          stored,
        }),
    ),
  invoke: (input) =>
    Effect.flatMap(
      definition.storage.get({
        scopeId: input.source.scopeId,
        sourceId: input.source.id,
      }),
      (stored) =>
        definition.catalog.invoke({
          ...input,
          stored,
        }),
    ),
});

const createExecutorSecretStoreContribution = <
  TAddInput,
  TConnectInput,
  TStoreConfig,
  TStored,
  TUpdateInput extends {
    storeId: string;
    config: TStoreConfig;
  },
>(
  definition: ExecutorSecretStorePluginDefinition<
    TAddInput,
    TConnectInput,
    TStoreConfig,
    TStored,
    TUpdateInput
  >,
): ExecutorSecretStoreContribution<TAddInput> => ({
  kind: definition.kind,
  displayName: definition.displayName,
  builtin: definition.builtin,
  canCreate: definition.add !== undefined,
  inputSchema: definition.add?.inputSchema,
  inputSignatureWidth: definition.add?.inputSignatureWidth,
  helpText: definition.add?.helpText,
  createStore: definition.add
    ? ({ args, host }) =>
        createExecutorSecretStorePluginApi(definition, host).createStore(
          definition.add!.toConnectInput(args),
        )
    : undefined,
  getStoreConfig: ({ store }) =>
    Effect.flatMap(
      definition.storage.get({
        scopeId: store.scopeId,
        storeId: store.id,
      }),
      (stored) => {
        if (stored === null) {
          return runtimeEffectError(
            "plugins",
            `${definition.displayName} store storage missing for ${store.id}`,
          );
        }

        return Effect.succeed(
          definition.store.toConfig({
            store,
            stored,
          }),
        );
      },
    ),
  updateStore: ({ store, config, host }) =>
    createExecutorSecretStorePluginApi(definition, host).updateStore({
      storeId: store.id,
      config: config as TStoreConfig,
    } as unknown as TUpdateInput),
  removeStore: ({ store, host }) =>
    createExecutorSecretStorePluginApi(definition, host).removeStore(store.id),
  getCapabilities: ({ store }) =>
    Effect.flatMap(
      definition.storage.get({
        scopeId: store.scopeId,
        storeId: store.id,
      }),
      (stored) =>
        Effect.succeed(
          definition.store.capabilities?.({
            store,
            stored,
          }) ?? {
            canCreateSecrets: definition.store.createSecret !== undefined,
            canUpdateSecrets: definition.store.updateSecret !== undefined,
            canDeleteSecrets: definition.store.deleteSecret !== undefined,
            canBrowseSecrets: definition.store.browseSecrets !== undefined,
            canImportSecrets: definition.store.importSecret !== undefined,
          },
        ),
    ),
  resolveSecret: ({ secret, store, context }) =>
    Effect.flatMap(
      definition.storage.get({
        scopeId: store.scopeId,
        storeId: store.id,
      }),
      (stored) =>
        definition.store.resolveSecret({
          secret,
          store,
          stored,
          context,
        }),
    ),
  createSecret: ({ store, purpose, value, name }) =>
    definition.store.createSecret
      ? Effect.flatMap(
          definition.storage.get({
            scopeId: store.scopeId,
            storeId: store.id,
          }),
          (stored) =>
            definition.store.createSecret!({
              store,
              stored,
              purpose,
              value,
              name,
            }),
        )
      : runtimeEffectError(
          "plugins",
          `Secret store ${store.id} does not support creating secrets.`,
        ),
  updateSecret: ({ secret, store, name, value }) =>
    definition.store.updateSecret
      ? Effect.flatMap(
          definition.storage.get({
            scopeId: store.scopeId,
            storeId: store.id,
          }),
          (stored) =>
            definition.store.updateSecret!({
              secret,
              store,
              stored,
              name,
              value,
            }),
        )
      : runtimeEffectError(
          "plugins",
          `Secret store ${store.id} does not support updating secrets.`,
        ),
  deleteSecret: ({ secret, store }) =>
    definition.store.deleteSecret
      ? Effect.flatMap(
          definition.storage.get({
            scopeId: store.scopeId,
            storeId: store.id,
          }),
          (stored) =>
            definition.store.deleteSecret!({
              secret,
              store,
              stored,
            }),
        )
      : runtimeEffectError(
          "plugins",
          `Secret store ${store.id} does not support deleting secrets.`,
        ),
  browseSecrets: ({ store, parentKey, query }) =>
    definition.store.browseSecrets
      ? Effect.flatMap(
          definition.storage.get({
            scopeId: store.scopeId,
            storeId: store.id,
          }),
          (stored) =>
            definition.store.browseSecrets!({
              store,
              stored,
              parentKey,
              query,
            }),
        )
      : runtimeEffectError(
          "plugins",
          `Secret store ${store.id} does not support browsing secrets.`,
        ),
  importSecret: ({ store, selectionKey, purpose, name }) =>
    definition.store.importSecret
      ? Effect.flatMap(
          definition.storage.get({
            scopeId: store.scopeId,
            storeId: store.id,
          }),
          (stored) =>
            definition.store.importSecret!({
              store,
              stored,
              selectionKey,
              purpose,
              name,
            }),
        )
      : runtimeEffectError(
          "plugins",
          `Secret store ${store.id} does not support importing secrets.`,
        ),
});

export const defineExecutorSourcePlugin = <
  const TKey extends string,
  TAddInput,
  TConnectInput,
  TSourceConfig,
  TStored,
  TUpdateInput extends {
    sourceId: string;
    config: TSourceConfig;
  },
  TExtension extends object = {},
>(
  input: ExecutorSourcePluginInput<
    TKey,
    TAddInput,
    TConnectInput,
    TSourceConfig,
    TStored,
    TUpdateInput,
    TExtension
  >,
): ExecutorSdkPlugin<TKey, TExtension> =>
  ((extendExecutor, start) =>
    defineExecutorSdkPlugin({
      key: input.key,
      extendExecutor: extendExecutor
        ? (pluginInput) =>
            extendExecutor({
              ...pluginInput,
              source: createExecutorSourcePluginApi(
                input.source,
                pluginInput.host as ExecutorSourcePluginInternalHost,
              ),
            })
        : undefined,
      start: start
        ? (pluginInput) =>
            start({
              ...pluginInput,
              source: createExecutorSourcePluginApi(
                input.source,
                pluginInput.host as ExecutorSourcePluginInternalHost,
              ),
            })
        : undefined,
      [executorSdkPluginInternalsSymbol]: {
        sources: [createExecutorSourceContribution(input.source)],
      },
    }))(input.extendExecutor, input.start);

export const defineExecutorSecretStorePlugin = <
  const TKey extends string,
  TAddInput,
  TConnectInput,
  TStoreConfig,
  TStored,
  TUpdateInput extends {
    storeId: string;
    config: TStoreConfig;
  },
  TExtension extends object = {},
>(
  input: ExecutorSecretStorePluginInput<
    TKey,
    TAddInput,
    TConnectInput,
    TStoreConfig,
    TStored,
    TUpdateInput,
    TExtension
  >,
): ExecutorSdkPlugin<TKey, TExtension> =>
  ((extendExecutor, start) =>
    defineExecutorSdkPlugin({
      key: input.key,
      extendExecutor: extendExecutor
        ? (pluginInput) =>
            extendExecutor({
              ...pluginInput,
              secretStore: createExecutorSecretStorePluginApi(
                input.secretStore,
                pluginInput.host as ExecutorSecretStorePluginInternalHost,
              ),
            })
        : undefined,
      start: start
        ? (pluginInput) =>
            start({
              ...pluginInput,
              secretStore: createExecutorSecretStorePluginApi(
                input.secretStore,
                pluginInput.host as ExecutorSecretStorePluginInternalHost,
              ),
            })
        : undefined,
      [executorSdkPluginInternalsSymbol]: {
        secretStores: [createExecutorSecretStoreContribution(input.secretStore)],
      },
    }))(input.extendExecutor, input.start);

export type ExecutorSdkPluginExtensions<
  TPlugins extends readonly ExecutorSdkPlugin<any, any>[],
> = {
  [TPlugin in TPlugins[number] as TPlugin["key"]]:
    TPlugin extends ExecutorSdkPlugin<any, infer TExtension>
      ? TExtension
      : never;
};

export const registerExecutorSdkPlugins = (
  plugins: readonly ExecutorSdkPlugin<any, any>[],
) => {
  const pluginKeys = new Set<string>();
  const sources = new Map<string, ExecutorSourceContribution<any>>();
  const secretStores = new Map<string, ExecutorSecretStoreContribution<any>>();

  for (const plugin of plugins) {
    if (pluginKeys.has(plugin.key)) {
      throw new Error(`Duplicate executor SDK plugin registration: ${plugin.key}`);
    }

    pluginKeys.add(plugin.key);

    const internals = plugin[executorSdkPluginInternalsSymbol];

    for (const source of internals?.sources ?? []) {
      if (sources.has(source.kind)) {
        throw new Error(
          `Duplicate source registration: ${source.kind}`,
        );
      }

      sources.set(source.kind, source);
    }

    for (const secretStore of internals?.secretStores ?? []) {
      if (secretStores.has(secretStore.kind)) {
        throw new Error(
          `Duplicate secret store registration: ${secretStore.kind}`,
        );
      }

      secretStores.set(secretStore.kind, secretStore);
    }
  }

  const getSourceContribution = (kind: string) => {
    const definition = sources.get(kind);
    if (!definition) {
      throw new Error(`Unsupported source kind: ${kind}`);
    }

    return definition;
  };

  const getSourceContributionForSource = (source: Pick<ExecutorSource, "kind">) =>
    getSourceContribution(source.kind);

  const getSecretStoreContribution = (kind: string) => {
    const definition = secretStores.get(kind);
    if (!definition) {
      throw new Error(`Unsupported secret store kind: ${kind}`);
    }

    return definition;
  };

  const getSecretStoreContributionForStore = (
    store: Pick<SecretStore, "kind">,
  ) => getSecretStoreContribution(store.kind);

  return {
    plugins,
    sources: [...sources.values()],
    secretStores: [...secretStores.values()],
    getSourceContribution,
    getSourceContributionForSource,
    getSecretStoreContribution,
    getSecretStoreContributionForStore,
  };
};
