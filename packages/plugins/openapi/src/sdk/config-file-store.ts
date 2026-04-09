/**
 * Config-file wrapper for OpenApiOperationStore.
 *
 * Decorates an underlying store so that `putSource` and `removeSource` also
 * write to executor.jsonc. Fully typed against `OpenApiOperationStore` — no
 * casts, no generic store shape.
 */

import { FileSystem } from "@effect/platform";
import type { Layer } from "effect";

import {
  makeConfigFileBinding,
  translateSecretHeaders,
} from "@executor/config";
import type { SourceConfig as ConfigFileSourceConfig } from "@executor/config";

import type { OpenApiOperationStore, StoredSource } from "./operation-store";

const toSourceConfig = (source: StoredSource): ConfigFileSourceConfig => ({
  kind: "openapi",
  spec: source.config.spec,
  baseUrl: source.config.baseUrl,
  namespace: source.namespace,
  headers: translateSecretHeaders(source.config.headers),
});

export const withConfigFile = (
  inner: OpenApiOperationStore,
  configPath: string,
  fsLayer: Layer.Layer<FileSystem.FileSystem>,
): OpenApiOperationStore => {
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
