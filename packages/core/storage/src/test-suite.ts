import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  StorageFieldError,
  StorageModelError,
  type ExecutorDBSchema,
  type ExecutorStorage,
  type StorageError,
  executorCoreSchema,
  mergeSchemas,
} from "./index";

export const storageContractSchema = mergeSchemas(executorCoreSchema, {
  contractValues: {
    modelName: "contractValues",
    tableName: "contract_values",
    primaryKey: ["id"],
    fields: {
      id: { type: "string", required: true },
      scopeId: { type: "string", columnName: "scope_id", required: true },
      label: { type: "string", required: true },
      rank: { type: "number", required: true, sortable: true },
      enabled: { type: "boolean", required: true },
      happenedAt: { type: "date", columnName: "happened_at", required: true, sortable: true },
      payload: { type: "json", required: true },
      tags: { type: "string[]", required: true },
      scores: { type: "number[]", required: true },
      blob: { type: "bytes", required: true },
    },
  },
} satisfies ExecutorDBSchema);

export interface StorageContractSuiteConfig {
  readonly makeStorage: () => Effect.Effect<ExecutorStorage, StorageError>;
  readonly schema: ExecutorDBSchema;
}

export const createStorageContractSuite = (name: string, config: StorageContractSuiteConfig) => {
  describe(`${name} storage contract`, () => {
    it.effect("creates and reads a row", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();
        const created = yield* storage.create<Record<string, unknown>>({
          model: "sources",
          data: { id: "src-1", scopeId: "scope-1", name: "GitHub", kind: "openapi" },
        });

        expect(created.name).toBe("GitHub");
        expect(created.config).toEqual({});
        expect(created.createdAt).toBeInstanceOf(Date);

        const found = yield* storage.findOne<Record<string, unknown>>({
          model: "sources",
          where: [
            { field: "id", value: "src-1" },
            { field: "scopeId", value: "scope-1" },
          ],
        });

        expect(found?.kind).toBe("openapi");
      }),
    );

    it.effect("filters, sorts, limits, offsets, and projects rows", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();
        yield* storage.create({
          model: "sources",
          data: { id: "a", scopeId: "s", name: "Alpha", kind: "openapi" },
        });
        yield* storage.create({
          model: "sources",
          data: { id: "b", scopeId: "s", name: "Beta", kind: "mcp" },
        });
        yield* storage.create({
          model: "sources",
          data: { id: "c", scopeId: "s", name: "Gamma", kind: "openapi" },
        });

        const rows = yield* storage.findMany<Record<string, unknown>>({
          model: "sources",
          where: [{ field: "name", operator: "contains", value: "a", mode: "insensitive" }],
          sortBy: { field: "name", direction: "asc" },
          offset: 1,
          limit: 1,
          select: ["id", "name"],
        });

        expect(rows).toEqual(
          [{ id: "Beta", name: "Beta" }].map((row) => ({ id: "b", name: row.name })),
        );
      }),
    );

    it.effect("supports the full where operator set", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();
        yield* storage.create({
          model: "contractValues",
          data: makeContractValue({ id: "a", label: "Alpha", rank: 1 }),
        });
        yield* storage.create({
          model: "contractValues",
          data: makeContractValue({ id: "b", label: "Beta", rank: 2 }),
        });
        yield* storage.create({
          model: "contractValues",
          data: makeContractValue({ id: "c", label: "Gamma", rank: 3 }),
        });

        expect(yield* ids(storage, [{ field: "rank", operator: "eq", value: 2 }])).toEqual(["b"]);
        expect(yield* ids(storage, [{ field: "rank", operator: "ne", value: 2 }])).toEqual([
          "a",
          "c",
        ]);
        expect(yield* ids(storage, [{ field: "rank", operator: "lt", value: 2 }])).toEqual(["a"]);
        expect(yield* ids(storage, [{ field: "rank", operator: "lte", value: 2 }])).toEqual([
          "a",
          "b",
        ]);
        expect(yield* ids(storage, [{ field: "rank", operator: "gt", value: 2 }])).toEqual(["c"]);
        expect(yield* ids(storage, [{ field: "rank", operator: "gte", value: 2 }])).toEqual([
          "b",
          "c",
        ]);
        expect(yield* ids(storage, [{ field: "rank", operator: "in", value: [1, 3] }])).toEqual([
          "a",
          "c",
        ]);
        expect(yield* ids(storage, [{ field: "rank", operator: "not_in", value: [1, 3] }])).toEqual(
          ["b"],
        );
        expect(
          yield* ids(storage, [{ field: "label", operator: "contains", value: "mm" }]),
        ).toEqual(["c"]);
        expect(
          yield* ids(storage, [{ field: "label", operator: "starts_with", value: "Al" }]),
        ).toEqual(["a"]);
        expect(
          yield* ids(storage, [{ field: "label", operator: "ends_with", value: "ta" }]),
        ).toEqual(["b"]);
      }),
    );

    it.effect("supports OR where connectors and count", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();
        yield* storage.create({
          model: "sources",
          data: { id: "a", scopeId: "s", name: "Alpha", kind: "openapi" },
        });
        yield* storage.create({
          model: "sources",
          data: { id: "b", scopeId: "s", name: "Beta", kind: "mcp" },
        });
        yield* storage.create({
          model: "sources",
          data: { id: "c", scopeId: "s", name: "Gamma", kind: "graphql" },
        });

        const count = yield* storage.count({
          model: "sources",
          where: [
            { field: "kind", value: "mcp" },
            { field: "kind", value: "graphql", connector: "OR" },
          ],
        });

        expect(count).toBe(2);
      }),
    );

    it.effect("round trips logical field types", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();
        const happenedAt = new Date("2026-04-10T12:34:56.789Z");
        const blob = new Uint8Array([1, 2, 3, 4]);
        yield* storage.create({
          model: "contractValues",
          data: makeContractValue({
            id: "types",
            rank: 42,
            enabled: true,
            happenedAt,
            payload: { nested: { ok: true }, count: 2 },
            tags: ["red", "blue"],
            scores: [9, 8],
            blob,
          }),
        });

        const found = yield* storage.findOne<Record<string, unknown>>({
          model: "contractValues",
          where: [{ field: "id", value: "types" }],
        });

        expect(found?.rank).toBe(42);
        expect(found?.enabled).toBe(true);
        expect(found?.happenedAt).toEqual(happenedAt);
        expect(found?.payload).toEqual({ nested: { ok: true }, count: 2 });
        expect(found?.tags).toEqual(["red", "blue"]);
        expect(found?.scores).toEqual([9, 8]);
        expect([...(found?.blob as Uint8Array)]).toEqual([1, 2, 3, 4]);
      }),
    );

    it.effect("updates and deletes rows", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();
        yield* storage.create({
          model: "sources",
          data: { id: "a", scopeId: "s", name: "Alpha", kind: "openapi" },
        });

        const updated = yield* storage.update<Record<string, unknown>>({
          model: "sources",
          where: [{ field: "id", value: "a" }],
          update: { name: "Updated" },
        });
        expect(updated?.name).toBe("Updated");

        const deleted = yield* storage.delete({
          model: "sources",
          where: [{ field: "id", value: "a" }],
        });
        expect(deleted).toBe(true);
        expect(yield* storage.count({ model: "sources" })).toBe(0);
      }),
    );

    it.effect("updates and deletes many rows", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();
        yield* storage.create({
          model: "contractValues",
          data: makeContractValue({ id: "a", label: "Alpha", rank: 1 }),
        });
        yield* storage.create({
          model: "contractValues",
          data: makeContractValue({ id: "b", label: "Beta", rank: 2 }),
        });
        yield* storage.create({
          model: "contractValues",
          data: makeContractValue({ id: "c", label: "Gamma", rank: 3 }),
        });

        const updated = yield* storage.updateMany({
          model: "contractValues",
          where: [{ field: "rank", operator: "gte", value: 2 }],
          update: { enabled: false },
        });
        expect(updated).toBe(2);
        expect(
          yield* storage.count({
            model: "contractValues",
            where: [{ field: "enabled", value: false }],
          }),
        ).toBe(2);

        const deleted = yield* storage.deleteMany({
          model: "contractValues",
          where: [{ field: "enabled", value: false }],
        });
        expect(deleted).toBe(2);
        expect(yield* storage.count({ model: "contractValues" })).toBe(1);
      }),
    );

    it.effect("commits successful transactions", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();
        yield* storage.transaction((tx) =>
          tx.create({
            model: "sources",
            data: { id: "committed", scopeId: "s", name: "Committed", kind: "openapi" },
          }),
        );

        expect(
          yield* storage.count({ model: "sources", where: [{ field: "id", value: "committed" }] }),
        ).toBe(1);
      }),
    );

    it.effect("rolls back failed transactions", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();

        const failed = yield* storage
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.create({
                model: "sources",
                data: { id: "a", scopeId: "s", name: "Alpha", kind: "openapi" },
              });
              return yield* new StorageModelError({ model: "missing", message: "forced rollback" });
            }),
          )
          .pipe(Effect.either);

        expect(failed._tag).toBe("Left");
        expect(yield* storage.count({ model: "sources" })).toBe(0);
      }),
    );

    it.effect("fails loudly for missing required fields and duplicate primary keys", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();

        const missingRequired = yield* storage
          .create({ model: "sources", data: { id: "missing", scopeId: "s", kind: "openapi" } })
          .pipe(Effect.either);
        expect(missingRequired._tag).toBe("Left");
        if (missingRequired._tag === "Left") {
          expect(missingRequired.left).toBeInstanceOf(StorageFieldError);
        }

        yield* storage.create({
          model: "sources",
          data: { id: "dup", scopeId: "s", name: "One", kind: "openapi" },
        });
        const duplicate = yield* storage
          .create({
            model: "sources",
            data: { id: "dup", scopeId: "s", name: "Two", kind: "openapi" },
          })
          .pipe(Effect.either);
        expect(duplicate._tag).toBe("Left");
      }),
    );

    it.effect("fails loudly for unknown models and fields", () =>
      Effect.gen(function* () {
        const storage = yield* config.makeStorage();

        const missingModel = yield* storage.count({ model: "missing" }).pipe(Effect.either);
        expect(missingModel._tag).toBe("Left");
        if (missingModel._tag === "Left") {
          expect(missingModel.left).toBeInstanceOf(StorageModelError);
        }

        const missingField = yield* storage
          .findMany({ model: "sources", where: [{ field: "missing", value: "x" }] })
          .pipe(Effect.either);
        expect(missingField._tag).toBe("Left");
        if (missingField._tag === "Left") {
          expect(missingField.left).toBeInstanceOf(StorageFieldError);
        }
      }),
    );
  });
};

const makeContractValue = (
  overrides: Partial<Record<string, unknown>> & { readonly id: string },
) => ({
  scopeId: "scope-1",
  label: "Value",
  rank: 1,
  enabled: true,
  happenedAt: new Date("2026-04-10T00:00:00.000Z"),
  payload: { ok: true },
  tags: ["tag"],
  scores: [1],
  blob: new Uint8Array([7]),
  ...overrides,
});

const ids = (
  storage: ExecutorStorage,
  where: Parameters<ExecutorStorage["findMany"]>[0]["where"],
) =>
  storage
    .findMany<Record<string, unknown>>({
      model: "contractValues",
      where,
      sortBy: { field: "rank", direction: "asc" },
      select: ["id"],
    })
    .pipe(Effect.map((rows) => rows.map((row) => row.id)));
