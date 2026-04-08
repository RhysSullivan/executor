import { Effect, Schema } from "effect";
import {
  makeInMemoryScopedKv,
  scopeKv,
  type Kv,
  type ScopedKv,
  type ToolId,
} from "@executor/core";

import {
  GoogleDiscoveryMethodBinding,
  GoogleDiscoveryStoredSourceData,
} from "./types";

const StoredBindingEntry = Schema.Struct({
  namespace: Schema.String,
  binding: GoogleDiscoveryMethodBinding,
});

const encodeBindingEntry = Schema.encodeSync(
  Schema.parseJson(StoredBindingEntry),
);
const decodeBindingEntry = Schema.decodeUnknownSync(
  Schema.parseJson(StoredBindingEntry),
);

export interface GoogleDiscoveryStoredSource {
  readonly namespace: string;
  readonly name: string;
  readonly config: GoogleDiscoveryStoredSourceData;
}

export interface GoogleDiscoveryBindingStore {
  readonly get: (
    toolId: ToolId,
  ) => Effect.Effect<{
    namespace: string;
    binding: GoogleDiscoveryMethodBinding;
  } | null>;

  readonly put: (
    toolId: ToolId,
    namespace: string,
    binding: GoogleDiscoveryMethodBinding,
  ) => Effect.Effect<void>;

  readonly listByNamespace: (
    namespace: string,
  ) => Effect.Effect<readonly ToolId[]>;

  readonly removeByNamespace: (
    namespace: string,
  ) => Effect.Effect<readonly ToolId[]>;

  readonly putSource: (source: GoogleDiscoveryStoredSource) => Effect.Effect<void>;
  readonly removeSource: (namespace: string) => Effect.Effect<void>;
  readonly listSources: () => Effect.Effect<readonly GoogleDiscoveryStoredSource[]>;
  readonly getSourceConfig: (
    namespace: string,
  ) => Effect.Effect<GoogleDiscoveryStoredSourceData | null>;
}

const makeStore = (
  bindings: ScopedKv,
  sources: ScopedKv,
): GoogleDiscoveryBindingStore => ({
  get: (toolId) =>
    Effect.gen(function* () {
      const raw = yield* bindings.get(toolId);
      if (!raw) return null;
      const entry = decodeBindingEntry(raw);
      return {
        namespace: entry.namespace,
        binding: entry.binding,
      };
    }),

  put: (toolId, namespace, binding) =>
    bindings.set(
      toolId,
      encodeBindingEntry({ namespace, binding }),
    ),

  listByNamespace: (namespace) =>
    Effect.gen(function* () {
      const entries = yield* bindings.list();
      const ids: ToolId[] = [];
      for (const entry of entries) {
        const decoded = decodeBindingEntry(entry.value);
        if (decoded.namespace === namespace) {
          ids.push(entry.key as ToolId);
        }
      }
      return ids;
    }),

  removeByNamespace: (namespace) =>
    Effect.gen(function* () {
      const entries = yield* bindings.list();
      const ids: ToolId[] = [];
      for (const entry of entries) {
        const decoded = decodeBindingEntry(entry.value);
        if (decoded.namespace === namespace) {
          ids.push(entry.key as ToolId);
          yield* bindings.delete(entry.key);
        }
      }
      return ids;
    }),

  putSource: (source) =>
    sources.set(source.namespace, JSON.stringify(source)),

  removeSource: (namespace) =>
    sources.delete(namespace).pipe(Effect.asVoid),

  listSources: () =>
    Effect.gen(function* () {
      const entries = yield* sources.list();
      return entries.map((e) => JSON.parse(e.value) as GoogleDiscoveryStoredSource);
    }),

  getSourceConfig: (namespace) =>
    Effect.gen(function* () {
      const raw = yield* sources.get(namespace);
      if (!raw) return null;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const source = JSON.parse(raw) as GoogleDiscoveryStoredSource;
      return source.config;
    }),
});

export const makeKvBindingStore = (
  kv: Kv,
  namespace: string,
): GoogleDiscoveryBindingStore =>
  makeStore(
    scopeKv(kv, `${namespace}.bindings`),
    scopeKv(kv, `${namespace}.sources`),
  );

export const makeInMemoryBindingStore = (): GoogleDiscoveryBindingStore =>
  makeStore(
    makeInMemoryScopedKv(),
    makeInMemoryScopedKv(),
  );
