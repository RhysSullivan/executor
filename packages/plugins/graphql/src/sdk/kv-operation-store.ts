// ---------------------------------------------------------------------------
// KV-backed GraphqlOperationStore
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";
import { scopeKv, makeInMemoryScopedKv, type Kv, type ToolId, type ScopedKv } from "@executor/sdk";

import type { GraphqlOperationStore, StoredSource } from "./operation-store";
import { InvocationConfig, OperationBinding } from "./types";
import { StoredSourceSchema } from "./stored-source";

// ---------------------------------------------------------------------------
// Stored schemas
// ---------------------------------------------------------------------------

class StoredEntry extends Schema.Class<StoredEntry>("StoredEntry")({
  namespace: Schema.String,
  binding: OperationBinding,
}) {}

const encodeEntry = Schema.encodeSync(Schema.parseJson(StoredEntry));
const decodeEntry = Schema.decodeUnknownSync(Schema.parseJson(StoredEntry));

const encodeSource = Schema.encodeSync(Schema.parseJson(StoredSourceSchema));
const decodeSource = Schema.decodeUnknownSync(Schema.parseJson(StoredSourceSchema));

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// TODO(migration): remove DecodedSource + rehydrate once all source rows
// have been migrated to carry invocationConfig. For GraphQL the endpoint
// is always user-provided in SourceConfig, so rehydration is lossless.
type DecodedSource = Omit<StoredSource, "invocationConfig"> & {
  invocationConfig?: InvocationConfig;
};

const rehydrate = (source: DecodedSource): StoredSource =>
  source.invocationConfig
    ? (source as StoredSource)
    : {
        ...source,
        invocationConfig: new InvocationConfig({
          endpoint: source.config.endpoint,
          headers: source.config.headers ?? {},
        }),
      };

const makeStore = (bindings: ScopedKv, sources: ScopedKv): GraphqlOperationStore => ({
  get: (toolId) =>
    Effect.gen(function* () {
      const raw = yield* bindings.get(toolId);
      if (!raw) return null;
      const entry = decodeEntry(raw);
      return { binding: entry.binding, namespace: entry.namespace };
    }),

  put: (toolId, namespace, binding) =>
    bindings.set([
      { key: toolId, value: encodeEntry(new StoredEntry({ namespace, binding })) },
    ]),

  remove: (toolId) => bindings.delete([toolId]).pipe(Effect.asVoid),

  listByNamespace: (namespace) =>
    Effect.gen(function* () {
      const entries = yield* bindings.list();
      const ids: ToolId[] = [];
      for (const e of entries) {
        const entry = decodeEntry(e.value);
        if (entry.namespace === namespace) ids.push(e.key as ToolId);
      }
      return ids;
    }),

  removeByNamespace: (namespace) =>
    Effect.gen(function* () {
      const entries = yield* bindings.list();
      const ids: ToolId[] = [];
      for (const e of entries) {
        const entry = decodeEntry(e.value);
        if (entry.namespace === namespace) ids.push(e.key as ToolId);
      }
      if (ids.length > 0) yield* bindings.delete(ids);
      return ids;
    }),

  putSource: (source) => sources.set([{ key: source.namespace, value: encodeSource(source) }]),

  removeSource: (namespace) => sources.delete([namespace]).pipe(Effect.asVoid),

  listSources: () =>
    Effect.gen(function* () {
      const entries = yield* sources.list();
      // TODO(migration): rehydrate in memory only — avoid N writes per list.
      return entries.map((e) => rehydrate(decodeSource(e.value) as DecodedSource));
    }),

  getSource: (namespace) =>
    Effect.gen(function* () {
      const raw = yield* sources.get(namespace);
      if (!raw) return null;
      const source = decodeSource(raw) as DecodedSource;
      if (source.invocationConfig) return source as StoredSource;
      // TODO(migration): self-heal — rehydrate and write back once.
      const healed = rehydrate(source);
      yield* sources.set([{ key: namespace, value: encodeSource(healed) }]);
      return healed;
    }),

  getSourceConfig: (namespace) =>
    Effect.gen(function* () {
      const raw = yield* sources.get(namespace);
      if (!raw) return null;
      const source = decodeSource(raw) as StoredSource;
      return source.config;
    }),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const makeKvOperationStore = (kv: Kv, namespace: string): GraphqlOperationStore =>
  makeStore(scopeKv(kv, `${namespace}.bindings`), scopeKv(kv, `${namespace}.sources`));

export const makeInMemoryOperationStore = (): GraphqlOperationStore =>
  makeStore(makeInMemoryScopedKv(), makeInMemoryScopedKv());
