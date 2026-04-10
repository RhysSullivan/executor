/**
 * Config-file wrapper for OpenApiOperationStore.
 *
 * Decorates an underlying store so that `putSource` and `removeSource` also
 * write to executor.jsonc.
 */

import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import type { Layer } from "effect";

import {
  addSourceToConfig,
  removeSourceFromConfig,
  SECRET_REF_PREFIX,
} from "@executor/config";
import type { SourceConfig as ConfigFileSourceConfig, ConfigHeaderValue } from "@executor/config";

import type { OpenApiOperationStore, StoredSource } from "./operation-store";

type PluginHeaderValue = string | { readonly secretId: string; readonly prefix?: string };

const translateSecretHeaders = (
  headers: Readonly<Record<string, PluginHeaderValue>> | undefined,
): Record<string, ConfigHeaderValue> | undefined => {
  if (!headers) return undefined;
  const result: Record<string, ConfigHeaderValue> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key] = value;
      continue;
    }
    const ref = `${SECRET_REF_PREFIX}${value.secretId}`;
    result[key] = value.prefix ? { value: ref, prefix: value.prefix } : ref;
  }
  return result;
};

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
): OpenApiOperationStore => ({
  ...inner,
  putSource: (source) =>
    Effect.gen(function* () {
      yield* inner.putSource(source);
      yield* addSourceToConfig(configPath, toSourceConfig(source)).pipe(
        Effect.provide(fsLayer),
        Effect.catchAll(() => Effect.void),
      );
    }),
  removeSource: (namespace) =>
    Effect.gen(function* () {
      yield* inner.removeSource(namespace);
      yield* removeSourceFromConfig(configPath, namespace).pipe(
        Effect.provide(fsLayer),
        Effect.catchAll(() => Effect.void),
      );
    }),
});
