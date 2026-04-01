// ---------------------------------------------------------------------------
// Adapt ScopedPluginKv → OpenApiOperationStore
//
// Works with any PluginKv backend (SQLite, in-memory, etc.)
// Uses Effect Schema for serialization/deserialization.
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";
import type { ToolId, ScopedKv } from "@executor/sdk";

import type { OpenApiOperationStore } from "./operation-store";
import { OperationBinding, InvocationConfig } from "./types";

// ---------------------------------------------------------------------------
// Stored entry schema
// ---------------------------------------------------------------------------

class StoredEntry extends Schema.Class<StoredEntry>("StoredEntry")({
  namespace: Schema.String,
  binding: OperationBinding,
  config: InvocationConfig,
}) {}

const encodeEntry = Schema.encodeSync(Schema.parseJson(StoredEntry));
const decodeEntry = Schema.decodeUnknownSync(Schema.parseJson(StoredEntry));

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const makeKvOperationStore = (kv: ScopedKv): OpenApiOperationStore => ({
  get: (toolId) =>
    Effect.gen(function* () {
      const raw = yield* kv.get(toolId);
      if (!raw) return null;
      const entry = decodeEntry(raw);
      return { binding: entry.binding, config: entry.config };
    }),

  put: (toolId, namespace, binding, config) =>
    Effect.gen(function* () {
      const raw = encodeEntry(new StoredEntry({ namespace, binding, config }));
      yield* kv.set(toolId, raw);
    }),

  remove: (toolId) =>
    kv.delete(toolId).pipe(Effect.asVoid),

  listByNamespace: (namespace) =>
    Effect.gen(function* () {
      const entries = yield* kv.list();
      const ids: ToolId[] = [];
      for (const e of entries) {
        const entry = decodeEntry(e.value);
        if (entry.namespace === namespace) ids.push(e.key as ToolId);
      }
      return ids;
    }),

  removeByNamespace: (namespace) =>
    Effect.gen(function* () {
      const entries = yield* kv.list();
      const ids: ToolId[] = [];
      for (const e of entries) {
        const entry = decodeEntry(e.value);
        if (entry.namespace === namespace) {
          ids.push(e.key as ToolId);
          yield* kv.delete(e.key);
        }
      }
      return ids;
    }),
});
