// ---------------------------------------------------------------------------
// KV-backed OpenApiOperationStore
//
// Uses two KV namespaces — one for bindings, one for sources (meta + config).
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";
import { scopeKv, makeInMemoryScopedKv, type Kv, type ToolId, type ScopedKv } from "@executor/sdk";

import type { OpenApiOperationStore, StoredOperation, StoredSource } from "./operation-store";
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

// TODO(migration): remove LegacyStoredEntry + rehydrateInvocationConfig
// once all source rows have been migrated off the pre-refactor schema.
// Old binding rows inlined the resolved InvocationConfig, which is the
// only place the server-derived baseUrl was persisted.
class LegacyStoredEntry extends Schema.Class<LegacyStoredEntry>("LegacyStoredEntry")({
  namespace: Schema.String,
  binding: OperationBinding,
  config: Schema.optional(InvocationConfig),
}) {}

const decodeLegacyEntry = Schema.decodeUnknownSync(Schema.parseJson(LegacyStoredEntry));

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

  // TODO(migration): remove along with LegacyStoredEntry.
  // Rebuild invocationConfig for a source row that predates the refactor.
  // We try to recover the resolved baseUrl from any legacy binding row
  // (old rows inlined the full InvocationConfig); if none is found, fall
  // back to the user-provided baseUrl from the source config.
  type DecodedSource = Omit<StoredSource, "invocationConfig"> & {
    invocationConfig?: InvocationConfig;
  };
  const rehydrateInvocationConfig = (
    source: DecodedSource,
  ): Effect.Effect<StoredSource> =>
    Effect.gen(function* () {
      if (source.invocationConfig) return source as StoredSource;
      let recovered: InvocationConfig | null = null;
      const entries = yield* bindings.list();
      for (const e of entries) {
        const legacy = decodeLegacyEntry(e.value);
        if (legacy.namespace === source.namespace && legacy.config) {
          recovered = legacy.config;
          break;
        }
      }
      const invocationConfig =
        recovered ??
        new InvocationConfig({
          baseUrl: source.config.baseUrl ?? "",
          headers: source.config.headers ?? {},
        });
      return { ...source, invocationConfig };
    });

  return {
    get: (toolId) =>
      Effect.gen(function* () {
        const raw = yield* bindings.get(toolId);
        if (!raw) return null;
        const entry = decodeEntry(raw);
        return { binding: entry.binding, namespace: entry.namespace };
      }),

    put: (entries: readonly StoredOperation[]) =>
      withKvTransaction(
        bindings,
        bindings.set(
          entries.map(({ toolId, namespace, binding }) => ({
            key: toolId,
            value: encodeEntry(new StoredEntry({ namespace, binding })),
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
        const out: StoredSource[] = [];
        for (const e of entries) {
          const raw = decodeSource(e.value) as DecodedSource;
          // TODO(migration): rehydrate in memory only — avoid N writes per list.
          out.push(
            raw.invocationConfig
              ? (raw as StoredSource)
              : yield* rehydrateInvocationConfig(raw),
          );
        }
        return out;
      }),

    getSource: (namespace) =>
      Effect.gen(function* () {
        const raw = yield* sources.get(namespace);
        if (!raw) return null;
        const source = decodeSource(raw) as DecodedSource;
        if (source.invocationConfig) return source as StoredSource;
        // TODO(migration): self-heal — rehydrate and write back once.
        const healed = yield* rehydrateInvocationConfig(source);
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
  };
};

// ---------------------------------------------------------------------------
// Factory from global Kv
// ---------------------------------------------------------------------------

export const makeKvOperationStore = (kv: Kv, namespace: string): OpenApiOperationStore =>
  makeStore(scopeKv(kv, `${namespace}.bindings`), scopeKv(kv, `${namespace}.sources`));

export const makeInMemoryOperationStore = (): OpenApiOperationStore =>
  makeStore(makeInMemoryScopedKv(), makeInMemoryScopedKv());
