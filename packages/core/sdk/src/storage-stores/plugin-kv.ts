// ---------------------------------------------------------------------------
// Storage-backed pluginKv
//
// Returns a factory `(namespace) => ScopedKv` bound to a scope, with rows
// written into the core `pluginKv` model via a generic ExecutorStorage.
// Replaces the old `Kv` interface from @executor/storage-file.
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { ExecutorStorage } from "@executor/storage";

import type { Scope } from "../scope";
import type { KvEntry, ScopedKv } from "../plugin-kv";

type PluginKvRow = {
  readonly scopeId: string;
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
};

export const makeStoragePluginKv = (storage: ExecutorStorage, scope: Scope) => {
  const scopeIdString = scope.id as string;

  const scoped = (namespace: string): ScopedKv => ({
    get: (key) =>
      storage
        .findOne<PluginKvRow>({
          model: "pluginKv",
          where: [
            { field: "scopeId", value: scopeIdString },
            { field: "namespace", value: namespace },
            { field: "key", value: key },
          ],
        })
        .pipe(
          Effect.map((row) => row?.value ?? null),
          Effect.orDie,
        ),

    set: (entries) =>
      Effect.gen(function* () {
        for (const entry of entries) {
          yield* upsertEntry(storage, scopeIdString, namespace, entry);
        }
      }),

    delete: (keys) =>
      Effect.gen(function* () {
        if (keys.length === 0) return 0;
        const deleted = yield* storage
          .deleteMany({
            model: "pluginKv",
            where: [
              { field: "scopeId", value: scopeIdString },
              { field: "namespace", value: namespace },
              { field: "key", operator: "in", value: keys as readonly string[] },
            ],
          })
          .pipe(Effect.orDie);
        return deleted;
      }),

    list: () =>
      storage
        .findMany<PluginKvRow>({
          model: "pluginKv",
          where: [
            { field: "scopeId", value: scopeIdString },
            { field: "namespace", value: namespace },
          ],
        })
        .pipe(
          Effect.map((rows) => rows.map((row) => ({ key: row.key, value: row.value }))),
          Effect.orDie,
        ),

    deleteAll: () =>
      storage
        .deleteMany({
          model: "pluginKv",
          where: [
            { field: "scopeId", value: scopeIdString },
            { field: "namespace", value: namespace },
          ],
        })
        .pipe(Effect.orDie),
  });

  return scoped;
};

const upsertEntry = (
  storage: ExecutorStorage,
  scopeIdString: string,
  namespace: string,
  entry: KvEntry,
) =>
  Effect.gen(function* () {
    const updated = yield* storage
      .update<PluginKvRow>({
        model: "pluginKv",
        where: [
          { field: "scopeId", value: scopeIdString },
          { field: "namespace", value: namespace },
          { field: "key", value: entry.key },
        ],
        update: { value: entry.value },
      })
      .pipe(Effect.orDie);

    if (updated) return;

    yield* storage
      .create<PluginKvRow>({
        model: "pluginKv",
        data: {
          scopeId: scopeIdString,
          namespace,
          key: entry.key,
          value: entry.value,
        },
      })
      .pipe(Effect.orDie);
  });
