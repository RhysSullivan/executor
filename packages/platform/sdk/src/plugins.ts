import * as Effect from "effect/Effect";

import type { SourceCatalogSyncResult } from "@executor/source-core";
import type {
  SourceCatalogKind,
} from "@executor/source-core";
import type { ExecutorEffect } from "./executor-effect";
import type { ExecutorScopeContext } from "./scope";
import type { Source as ExecutorSource } from "./schema";
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

  return {
    plugins,
    sources: [...sources.values()],
    getSourceContribution,
    getSourceContributionForSource,
  };
};
