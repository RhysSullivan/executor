/**
 * Config-file wrapper for McpBindingStore.
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
} from "@executor/config";
import type { SourceConfig as ConfigFileSourceConfig } from "@executor/config";

import type { McpBindingStore, McpStoredSource } from "./binding-store";

const toSourceConfig = (source: McpStoredSource): ConfigFileSourceConfig => {
  if (source.config.transport === "stdio") {
    const d = source.config;
    return {
      kind: "mcp",
      transport: "stdio",
      name: source.name,
      command: d.command,
      args: d.args ? [...d.args] : undefined,
      env: d.env,
      cwd: d.cwd,
      namespace: source.namespace,
    };
  }

  const d = source.config;
  return {
    kind: "mcp",
    transport: "remote",
    name: source.name,
    endpoint: d.endpoint,
    remoteTransport: d.remoteTransport,
    queryParams: d.queryParams,
    headers: d.headers,
    namespace: source.namespace,
  };
};

export const withConfigFile = (
  inner: McpBindingStore,
  configPath: string,
  fsLayer: Layer.Layer<FileSystem.FileSystem>,
): McpBindingStore => ({
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
