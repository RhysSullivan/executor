// ---------------------------------------------------------------------------
// KV-backed GraphqlOperationStore
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";
import { scopeKv, makeInMemoryScopedKv, type Kv, type ToolId, type ScopedKv } from "@executor/core";

import type { GraphqlOperationStore, StoredSource } from "./operation-store";
import { OperationBinding, InvocationConfig, HeaderValue } from "./types";

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

const StoredSourceSchema = Schema.Struct({
  namespace: Schema.String,
  name: Schema.String,
  config: Schema.Struct({
    endpoint: Schema.String,
    introspectionJson: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    headers: Schema.optional(
      Schema.Record({ key: Schema.String, value: HeaderValue }),
    ),
  }),
});
const encodeSource = Schema.encodeSync(Schema.parseJson(StoredSourceSchema));
const decodeSource = Schema.decodeUnknownSync(Schema.parseJson(StoredSourceSchema));

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const makeStore = (
  bindings: ScopedKv,
  sources: ScopedKv,
): GraphqlOperationStore => ({
  get: (toolId) =>
    Effect.gen(function* () {
      const raw = yield* bindings.get(toolId);
      if (!raw) return null;
      const entry = decodeEntry(raw);
      return { binding: entry.binding, config: entry.config };
    }),

  put: (toolId, namespace, binding, config) =>
    bindings.set(
      toolId,
      encodeEntry(new StoredEntry({ namespace, binding, config })),
    ),

  remove: (toolId) => bindings.delete(toolId).pipe(Effect.asVoid),

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
        if (entry.namespace === namespace) {
          ids.push(e.key as ToolId);
          yield* bindings.delete(e.key);
        }
      }
      return ids;
    }),

  putSource: (source) =>
    sources.set(source.namespace, encodeSource(source)),

  removeSource: (namespace) =>
    sources.delete(namespace).pipe(Effect.asVoid),

  listSources: () =>
    Effect.gen(function* () {
      const entries = yield* sources.list();
      return entries.map((e) => decodeSource(e.value) as StoredSource);
    }),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const makeKvOperationStore = (
  kv: Kv,
  namespace: string,
): GraphqlOperationStore =>
  makeStore(
    scopeKv(kv, `${namespace}.bindings`),
    scopeKv(kv, `${namespace}.sources`),
  );

export const makeInMemoryOperationStore = (): GraphqlOperationStore =>
  makeStore(
    makeInMemoryScopedKv(),
    makeInMemoryScopedKv(),
  );
