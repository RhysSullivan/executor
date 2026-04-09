/**
 * Config-file wrapper for McpBindingStore.
 */

import { FileSystem } from "@effect/platform";
import type { Layer } from "effect";

import {
  makeConfigFileBinding,
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
): McpBindingStore => {
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
