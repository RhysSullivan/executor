// ---------------------------------------------------------------------------
// ConfigFileSink — best-effort write-back of source changes to executor.jsonc.
//
// Plugins (openapi, graphql, mcp) call `sink.upsertSource` after their DB
// writes so the committable file stays in sync with runtime state. Errors
// are logged and swallowed — a failed file write must never fail a DB
// mutation, and the next successful mutation (or a boot-time sync) will
// eventually reconcile.
//
// The FileSystem layer is injected so library code here doesn't pick a
// platform binding. The host app provides NodeFileSystem (or BunFileSystem).
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { Layer } from "effect";
import type { FileSystem } from "@effect/platform";

import type { SourceConfig } from "./schema";
import { addSourceToConfig, removeSourceFromConfig } from "./write";

export {
  headerToConfigValue,
  headersToConfigValues,
  type PluginHeaderValue,
} from "./transform";

export interface ConfigFileSink {
  readonly upsertSource: (source: SourceConfig) => Effect.Effect<void>;
  readonly removeSource: (namespace: string) => Effect.Effect<void>;
}

export interface ConfigFileSinkOptions {
  readonly path: string;
  readonly fsLayer: Layer.Layer<FileSystem.FileSystem>;
  /** Called when a file operation fails. Defaults to console.warn. */
  readonly onError?: (op: "upsert" | "remove", err: unknown) => void;
}

const defaultOnError = (op: "upsert" | "remove", err: unknown): void => {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[config-sink] ${op} failed: ${msg}`);
};

export const makeFileConfigSink = (
  options: ConfigFileSinkOptions,
): ConfigFileSink => {
  const { path, fsLayer, onError = defaultOnError } = options;

  return {
    upsertSource: (source) =>
      addSourceToConfig(path, source).pipe(
        Effect.provide(fsLayer),
        Effect.catchAll((err) => Effect.sync(() => onError("upsert", err))),
      ),

    removeSource: (namespace) =>
      removeSourceFromConfig(path, namespace).pipe(
        Effect.provide(fsLayer),
        Effect.catchAll((err) => Effect.sync(() => onError("remove", err))),
      ),
  };
};
