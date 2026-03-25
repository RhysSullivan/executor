import type { SourceCatalogSyncResult } from "@executor/source-core";
import type {
  Source,
  SourceCatalogKind,
} from "@executor/source-core";
import type { ExecutorEffect } from "./executor-effect";
import type { Source as ExecutorSource } from "./schema";
import type {
  SourceInvokeInput,
  SourceInvokeResult,
  SourceSyncInput,
} from "@executor/source-core";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

export type ExecutorSdkPlugin<
  TKey extends string = string,
  TExtension extends object = {},
> = {
  key: TKey;
  sources?: readonly SourcePluginRuntime[];
  sourceConnectors?: readonly ExecutorSourceConnector<any>[];
  extendExecutor?: (input: {
    executor: ExecutorEffect & Record<string, unknown>;
    host: ExecutorSdkPluginHost;
  }) => TExtension;
};

export type ExecutorSdkPluginHost = {
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

export type ExecutorSourceConnector<TInput = unknown> = {
  kind: string;
  displayName: string;
  inputSchema: Schema.Schema<TInput, any, never>;
  inputSignatureWidth?: number;
  helpText?: readonly string[];
  createSource: (input: {
    args: TInput;
    host: ExecutorSdkPluginHost;
  }) => Effect.Effect<ExecutorSource, Error, any>;
};

export type ExecutorSdkPluginExtensions<
  TPlugins extends readonly ExecutorSdkPlugin<any, any>[],
> = {
  [TPlugin in TPlugins[number] as TPlugin["key"]]:
    TPlugin extends ExecutorSdkPlugin<any, infer TExtension>
      ? TExtension
      : never;
};

export type SourcePluginRuntime = {
  kind: string;
  displayName: string;
  catalogKind: SourceCatalogKind;
  catalogIdentity?: (input: {
    source: Source;
  }) => Record<string, unknown>;
  getIrModel: (
    input: SourceSyncInput,
  ) => Effect.Effect<SourceCatalogSyncResult, Error, any>;
  invoke: (
    input: SourceInvokeInput,
  ) => Effect.Effect<SourceInvokeResult, Error, any>;
};

export const registerExecutorSdkPlugins = (
  plugins: readonly ExecutorSdkPlugin[],
) => {
  const pluginKeys = new Set<string>();
  const sourcePlugins = new Map<string, SourcePluginRuntime>();
  const sourceConnectors = new Map<string, ExecutorSourceConnector<any>>();

  for (const plugin of plugins) {
    if (pluginKeys.has(plugin.key)) {
      throw new Error(`Duplicate executor SDK plugin registration: ${plugin.key}`);
    }

    pluginKeys.add(plugin.key);

    for (const source of plugin.sources ?? []) {
      if (sourcePlugins.has(source.kind)) {
        throw new Error(
          `Duplicate source plugin registration: ${source.kind}`,
        );
      }

      sourcePlugins.set(source.kind, source);
    }
    for (const connector of plugin.sourceConnectors ?? []) {
      if (sourceConnectors.has(connector.kind)) {
        throw new Error(
          `Duplicate source connector registration: ${connector.kind}`,
        );
      }

      sourceConnectors.set(connector.kind, connector);
    }
  }

  const getSourcePlugin = (kind: string) => {
    const definition = sourcePlugins.get(kind);
    if (!definition) {
      throw new Error(`Unsupported source plugin: ${kind}`);
    }

    return definition;
  };

  const getSourcePluginForSource = (source: Pick<Source, "kind">) =>
    getSourcePlugin(source.kind);

  return {
    plugins,
    sourcePlugins: [...sourcePlugins.values()],
    sourceConnectors: [...sourceConnectors.values()],
    getSourcePlugin,
    getSourcePluginForSource,
    sourcePluginCatalogKind: (kind: string): SourceCatalogKind =>
      getSourcePlugin(kind).catalogKind,
    isInternalSourcePluginKind: (kind: string): boolean =>
      getSourcePlugin(kind).catalogKind === "internal",
  };
};
