/**
 * Config-file wrapper for GraphqlOperationStore.
 */

import { FileSystem } from "@effect/platform";
import type { Layer } from "effect";

import {
  makeConfigFileBinding,
  translateSecretHeaders,
} from "@executor/config";
import type { SourceConfig as ConfigFileSourceConfig } from "@executor/config";

import type { GraphqlOperationStore, StoredSource } from "./operation-store";

const toSourceConfig = (source: StoredSource): ConfigFileSourceConfig => ({
  kind: "graphql",
  endpoint: source.config.endpoint,
  introspectionJson: source.config.introspectionJson,
  namespace: source.namespace,
  headers: translateSecretHeaders(source.config.headers),
});

export const withConfigFile = (
  inner: GraphqlOperationStore,
  configPath: string,
  fsLayer: Layer.Layer<FileSystem.FileSystem>,
): GraphqlOperationStore => {
  const binding = makeConfigFileBinding({
    innerPut: inner.putSource,
    innerRemove: inner.removeSource,
    toSourceConfig,
    configPath,
    fsLayer,
  });

  return {
    ...inner,
    putSource: binding.putSource,
    removeSource: binding.removeSource,
  };
};
