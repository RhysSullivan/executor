/**
 * Helpers for plugins that write back to executor.jsonc.
 *
 * Plugins that use secret-ref headers (openapi, graphql) store them as
 * `{ secretId, prefix? }` objects in their KV stores. The jsonc file format
 * uses a different representation — a string prefixed with `secret-public-ref:`
 * or a `{ value, prefix }` struct. This helper translates between them.
 */

import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import type { Layer } from "effect";

import {
  addSourceToConfig,
  removeSourceFromConfig,
} from "./write";
import { SECRET_REF_PREFIX } from "./schema";
import type { ConfigHeaderValue, SourceConfig } from "./schema";

// ---------------------------------------------------------------------------
// Secret-ref header translation (openapi + graphql)
// ---------------------------------------------------------------------------

/** A header value as stored by plugins — plain string or secret ref. */
export type PluginHeaderValue =
  | string
  | { readonly secretId: string; readonly prefix?: string };

/**
 * Translate a plugin's header record into the config-file format.
 * `{ secretId, prefix }` becomes `"secret-public-ref:id"` (with optional prefix).
 */
export const translateSecretHeaders = (
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

// ---------------------------------------------------------------------------
// Source wrapper builders
//
// These return a pair of wrapped methods that write to the config file
// after the underlying store succeeds. Plugins use these to build a typed
// `withConfigFile` wrapper around their own store.
// ---------------------------------------------------------------------------

export interface ConfigFileBinding<TSource> {
  readonly putSource: (source: TSource) => Effect.Effect<void>;
  readonly removeSource: (namespace: string) => Effect.Effect<void>;
}

export const makeConfigFileBinding = <TSource>(options: {
  readonly innerPut: (source: TSource) => Effect.Effect<void>;
  readonly innerRemove: (namespace: string) => Effect.Effect<void>;
  readonly toSourceConfig: (source: TSource) => SourceConfig;
  readonly configPath: string;
  readonly fsLayer: Layer.Layer<FileSystem.FileSystem>;
}): ConfigFileBinding<TSource> => ({
  putSource: (source) =>
    Effect.gen(function* () {
      yield* options.innerPut(source);
      yield* addSourceToConfig(
        options.configPath,
        options.toSourceConfig(source),
      ).pipe(
        Effect.provide(options.fsLayer),
        Effect.catchAll(() => Effect.void),
      );
    }),

  removeSource: (namespace) =>
    Effect.gen(function* () {
      yield* options.innerRemove(namespace);
      yield* removeSourceFromConfig(options.configPath, namespace).pipe(
        Effect.provide(options.fsLayer),
        Effect.catchAll(() => Effect.void),
      );
    }),
});
