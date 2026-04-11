// ---------------------------------------------------------------------------
// KV-backed OpenApiOperationStore
//
// Uses two KV namespaces — one for bindings, one for sources (meta + config).
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";
import { scopeKv, makeInMemoryScopedKv, type Kv, type ToolId, type ScopedKv } from "@executor/sdk";

import type { OpenApiOperationStore, StoredOperation, StoredSource } from "./operation-store";
import { OperationBinding, InvocationConfig } from "./types";
import { StoredSourceSchema } from "./stored-source";

// ---------------------------------------------------------------------------
// Stored schemas
// ---------------------------------------------------------------------------

class StoredEntry extends Schema.Class<StoredEntry>("StoredEntry")({
  namespace: Schema.String,
  binding: OperationBinding,
  config: InvocationConfig,
}) {}

const encodeEntry = Schema.encodeSync(Schema.parseJson(StoredEntry));
const decodeEntry = Schema.decodeUnknownSync(Schema.parseJson(StoredEntry));

const encodeSource = Schema.encodeSync(Schema.parseJson(StoredSourceSchema));
const decodeSource = Schema.decodeUnknownSync(Schema.parseJson(StoredSourceSchema));

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const makeStore = (bindings: ScopedKv, sources: ScopedKv): OpenApiOperationStore => {
  const withKvTransaction = <A, E>(
    kv: ScopedKv,
    effect: Effect.Effect<A, E, never>,
  ): Effect.Effect<A, E, never> => kv.withTransaction?.(effect) ?? effect;

  return {
    get: (toolId) =>
      Effect.gen(function* () {
        const raw = yield* bindings.get(toolId);
        if (!raw) return null;
        const entry = decodeEntry(raw);
        return { binding: entry.binding, config: entry.config };
      }),

    put: (entries: readonly StoredOperation[]) =>
      withKvTransaction(
        bindings,
        bindings.set(
          entries.map(({ toolId, namespace, binding, config }) => ({
            key: toolId,
            value: encodeEntry(new StoredEntry({ namespace, binding, config })),
          })),
        ),
      ),

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
        return entries.map((e) => decodeSource(e.value) as StoredSource);
      }),

    getSource: (namespace) =>
      Effect.gen(function* () {
        const raw = yield* sources.get(namespace);
        if (!raw) return null;
        return decodeSource(raw) as StoredSource;
      }),

    getSourceConfig: (namespace) =>
      Effect.gen(function* () {
        const raw = yield* sources.get(namespace);
        if (!raw) return null;
        const source = decodeSource(raw) as StoredSource;
        return source.config;
      }),
  };
};

// ---------------------------------------------------------------------------
// Factory from global Kv
// ---------------------------------------------------------------------------

export const makeKvOperationStore = (kv: Kv, namespace: string): OpenApiOperationStore =>
  makeStore(scopeKv(kv, `${namespace}.bindings`), scopeKv(kv, `${namespace}.sources`));

export const makeInMemoryOperationStore = (): OpenApiOperationStore =>
  makeStore(makeInMemoryScopedKv(), makeInMemoryScopedKv());
