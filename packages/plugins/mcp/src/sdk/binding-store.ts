// ---------------------------------------------------------------------------
// McpBindingStore — plugin's own storage for tool bindings + source data
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";
import {
  makeInMemoryScopedKv,
  scopeKv,
  type Kv,
  type ToolId,
  type ScopedKv,
} from "@executor/sdk";

import { McpToolBinding } from "./types";
import type { McpStoredSourceData } from "./types";

// ---------------------------------------------------------------------------
// Stored source — combines meta + config into one entry
// ---------------------------------------------------------------------------

export interface McpStoredSource {
  readonly namespace: string;
  readonly name: string;
  readonly config: McpStoredSourceData;
}

// ---------------------------------------------------------------------------
// Stored binding schema
// ---------------------------------------------------------------------------

const StoredBindingEntry = Schema.Struct({
  namespace: Schema.String,
  binding: McpToolBinding,
  sourceData: Schema.Unknown,
});

const encodeBindingEntry = Schema.encodeSync(
  Schema.parseJson(StoredBindingEntry),
);
const decodeBindingEntry = Schema.decodeUnknownSync(
  Schema.parseJson(StoredBindingEntry),
);

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface McpBindingStore {
  readonly get: (
    toolId: ToolId,
  ) => Effect.Effect<{
    binding: McpToolBinding;
    sourceData: McpStoredSourceData;
  } | null>;

  readonly put: (
    toolId: ToolId,
    namespace: string,
    binding: McpToolBinding,
    sourceData: McpStoredSourceData,
  ) => Effect.Effect<void>;

  readonly remove: (toolId: ToolId) => Effect.Effect<void>;

  readonly listByNamespace: (
    namespace: string,
  ) => Effect.Effect<readonly ToolId[]>;

  readonly removeByNamespace: (
    namespace: string,
  ) => Effect.Effect<readonly ToolId[]>;

  readonly putSource: (source: McpStoredSource) => Effect.Effect<void>;
  readonly removeSource: (namespace: string) => Effect.Effect<void>;
  readonly listSources: () => Effect.Effect<readonly McpStoredSource[]>;
  readonly getSource: (
    namespace: string,
  ) => Effect.Effect<McpStoredSource | null>;
  readonly getSourceConfig: (
    namespace: string,
  ) => Effect.Effect<McpStoredSourceData | null>;
}

// ---------------------------------------------------------------------------
// Implementation — two KV namespaces: bindings + sources
// ---------------------------------------------------------------------------

const makeStore = (
  bindings: ScopedKv,
  sources: ScopedKv,
): McpBindingStore => ({
  // ---- Bindings ----

  get: (toolId) =>
    Effect.gen(function* () {
      const raw = yield* bindings.get(toolId);
      if (!raw) return null;
      const entry = decodeBindingEntry(raw);
      return {
        binding: entry.binding as McpToolBinding,
        sourceData: entry.sourceData as McpStoredSourceData,
      };
    }),

  put: (toolId, namespace, binding, sourceData) =>
    bindings.set(
      toolId,
      encodeBindingEntry({ namespace, binding, sourceData }),
    ),

  remove: (toolId) => bindings.delete(toolId).pipe(Effect.asVoid),

  listByNamespace: (namespace) =>
    Effect.gen(function* () {
      const entries = yield* bindings.list();
      const ids: ToolId[] = [];
      for (const e of entries) {
        const entry = decodeBindingEntry(e.value);
        if (entry.namespace === namespace) ids.push(e.key as ToolId);
      }
      return ids;
    }),

  removeByNamespace: (namespace) =>
    Effect.gen(function* () {
      const entries = yield* bindings.list();
      const ids: ToolId[] = [];
      for (const e of entries) {
        const entry = decodeBindingEntry(e.value);
        if (entry.namespace === namespace) {
          ids.push(e.key as ToolId);
          yield* bindings.delete(e.key);
        }
      }
      return ids;
    }),

  // ---- Sources (meta + config combined) ----

  putSource: (source) =>
    sources.set(source.namespace, JSON.stringify(source)),

  removeSource: (namespace) =>
    sources.delete(namespace).pipe(Effect.asVoid),

  listSources: () =>
    Effect.gen(function* () {
      const entries = yield* sources.list();
      return entries.map((e) => JSON.parse(e.value) as McpStoredSource);
    }),

  getSource: (namespace) =>
    Effect.gen(function* () {
      const raw = yield* sources.get(namespace);
      if (!raw) return null;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      return JSON.parse(raw) as McpStoredSource;
    }),

  getSourceConfig: (namespace) =>
    Effect.gen(function* () {
      const raw = yield* sources.get(namespace);
      if (!raw) return null;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const source = JSON.parse(raw) as McpStoredSource;
      return source.config;
    }),
});

// ---------------------------------------------------------------------------
// Factory from global Kv — two scoped sub-namespaces
// ---------------------------------------------------------------------------

export const makeKvBindingStore = (
  kv: Kv,
  namespace: string,
): McpBindingStore =>
  makeStore(
    scopeKv(kv, `${namespace}.bindings`),
    scopeKv(kv, `${namespace}.sources`),
  );

// ---------------------------------------------------------------------------
// In-memory convenience
// ---------------------------------------------------------------------------

export const makeInMemoryBindingStore = (): McpBindingStore =>
  makeStore(
    makeInMemoryScopedKv(),
    makeInMemoryScopedKv(),
  );
