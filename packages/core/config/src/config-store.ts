/**
 * Config-file-backed store wrappers.
 *
 * These decorate an existing operation store (KV-backed) and intercept
 * putSource/removeSource to also persist source entries to executor.jsonc.
 * Derived data (bindings) still goes to the inner KV store.
 */

import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import type { Layer } from "effect";
import { addSourceToConfig, removeSourceFromConfig } from "./write";
import { SECRET_REF_PREFIX } from "./schema";
import type { SourceConfig } from "./schema";

// ---------------------------------------------------------------------------
// Header translation: plugin format (secretId) → config format (secret)
// ---------------------------------------------------------------------------

const translateHeadersToConfig = (
  headers: Record<string, unknown> | undefined,
): Record<string, string | { value: string; prefix?: string }> | undefined => {
  if (!headers) return undefined;
  const result: Record<string, string | { value: string; prefix?: string }> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (value && typeof value === "object" && "secretId" in value) {
      const v = value as { secretId: string; prefix?: string };
      const ref = `${SECRET_REF_PREFIX}${v.secretId}`;
      if (v.prefix) {
        result[key] = { value: ref, prefix: v.prefix };
      } else {
        result[key] = ref;
      }
    }
  }
  return result;
};

// ---------------------------------------------------------------------------
// Plugin source → config file SourceConfig translators
// ---------------------------------------------------------------------------

const openApiToSourceConfig = (source: {
  namespace: string;
  config: { spec: string; baseUrl?: string; namespace?: string; headers?: Record<string, unknown> };
}): SourceConfig => ({
  kind: "openapi" as const,
  spec: source.config.spec,
  baseUrl: source.config.baseUrl,
  namespace: source.namespace,
  headers: translateHeadersToConfig(source.config.headers),
});

const graphqlToSourceConfig = (source: {
  namespace: string;
  config: {
    endpoint: string;
    introspectionJson?: string;
    namespace?: string;
    headers?: Record<string, unknown>;
  };
}): SourceConfig => ({
  kind: "graphql" as const,
  endpoint: source.config.endpoint,
  introspectionJson: source.config.introspectionJson,
  namespace: source.namespace,
  headers: translateHeadersToConfig(source.config.headers),
});

const mcpToSourceConfig = (source: {
  namespace: string;
  name: string;
  config: { transport: string; [key: string]: unknown };
}): SourceConfig => {
  if (source.config.transport === "stdio") {
    const d = source.config as {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    };
    return {
      kind: "mcp" as const,
      transport: "stdio" as const,
      name: source.name,
      command: d.command,
      args: d.args,
      env: d.env,
      cwd: d.cwd,
      namespace: source.namespace,
    };
  }

  const d = source.config as {
    transport: "remote";
    endpoint: string;
    remoteTransport?: "streamable-http" | "sse" | "auto";
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
  };
  return {
    kind: "mcp" as const,
    transport: "remote" as const,
    name: source.name,
    endpoint: d.endpoint,
    remoteTransport: d.remoteTransport,
    queryParams: d.queryParams,
    headers: d.headers,
    namespace: source.namespace,
  };
};

// ---------------------------------------------------------------------------
// Core wrapper logic
// ---------------------------------------------------------------------------

const wrapPutSource =
  <TSource extends { namespace: string }>(
    innerPut: (source: TSource) => Effect.Effect<void>,
    configPath: string,
    toSourceConfig: (source: TSource) => SourceConfig,
    fsLayer: Layer.Layer<FileSystem.FileSystem>,
  ) =>
  (source: TSource) =>
    Effect.gen(function* () {
      yield* innerPut(source);
      yield* addSourceToConfig(configPath, toSourceConfig(source)).pipe(
        Effect.provide(fsLayer),
        Effect.catchAll(() => Effect.void),
      );
    });

const wrapRemoveSource =
  (
    innerRemove: (namespace: string) => Effect.Effect<void>,
    configPath: string,
    fsLayer: Layer.Layer<FileSystem.FileSystem>,
  ) =>
  (namespace: string) =>
    Effect.gen(function* () {
      yield* innerRemove(namespace);
      yield* removeSourceFromConfig(configPath, namespace).pipe(
        Effect.provide(fsLayer),
        Effect.catchAll(() => Effect.void),
      );
    });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface StoreWithSource<TSource> {
  putSource: (source: TSource) => Effect.Effect<void>;
  removeSource: (namespace: string) => Effect.Effect<void>;
}

/**
 * Wrap a plugin store so putSource/removeSource also write to executor.jsonc.
 * Preserves the full store type — only the two methods are intercepted.
 */
export const withConfigFile = {
  openapi: <TStore extends StoreWithSource<{ namespace: string; name: string; config: any }>>(
    inner: TStore,
    configPath: string,
    fsLayer: Layer.Layer<FileSystem.FileSystem>,
  ): TStore =>
    ({
      ...inner,
      putSource: wrapPutSource(inner.putSource, configPath, openApiToSourceConfig as any, fsLayer),
      removeSource: wrapRemoveSource(inner.removeSource, configPath, fsLayer),
    }) as TStore,

  graphql: <TStore extends StoreWithSource<{ namespace: string; name: string; config: any }>>(
    inner: TStore,
    configPath: string,
    fsLayer: Layer.Layer<FileSystem.FileSystem>,
  ): TStore =>
    ({
      ...inner,
      putSource: wrapPutSource(inner.putSource, configPath, graphqlToSourceConfig as any, fsLayer),
      removeSource: wrapRemoveSource(inner.removeSource, configPath, fsLayer),
    }) as TStore,

  mcp: <TStore extends StoreWithSource<{ namespace: string; name: string; config: any }>>(
    inner: TStore,
    configPath: string,
    fsLayer: Layer.Layer<FileSystem.FileSystem>,
  ): TStore =>
    ({
      ...inner,
      putSource: wrapPutSource(inner.putSource, configPath, mcpToSourceConfig as any, fsLayer),
      removeSource: wrapRemoveSource(inner.removeSource, configPath, fsLayer),
    }) as TStore,
};
