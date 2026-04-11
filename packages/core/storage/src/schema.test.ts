import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  composeExecutorSchema,
  executorCoreSchema,
  getField,
  getModel,
  mergeSchemas,
} from "./index";

describe("storage schema helpers", () => {
  it("merges schemas, composes plugin schemas, and rejects duplicate models", () => {
    const custom = {
      customRecords: {
        modelName: "customRecords",
        tableName: "custom_records",
        primaryKey: ["id"],
        fields: {
          id: { type: "string", required: true },
        },
      },
    } as const;

    const merged = mergeSchemas(executorCoreSchema, custom);
    expect(merged.customRecords?.tableName).toBe("custom_records");
    expect(() => mergeSchemas(custom, custom)).toThrow('Duplicate storage model "customRecords"');

    const composed = composeExecutorSchema({
      plugins: [{ storage: { schema: custom } }],
    });
    expect(composed.customRecords?.tableName).toBe("custom_records");
  });

  it.effect("looks up models and fields", () =>
    Effect.gen(function* () {
      const tools = yield* getModel(executorCoreSchema, "tools");
      const sourceId = yield* getField(tools, "sourceId");

      expect(tools.tableName).toBe("tools");
      expect(sourceId.columnName).toBe("source_id");
    }),
  );

  it("rejects duplicate index names across models", () => {
    expect(() =>
      mergeSchemas(
        {
          first: {
            modelName: "first",
            tableName: "first",
            primaryKey: ["id"],
            indexes: [{ name: "idx_duplicate", fields: ["id"] }],
            fields: {
              id: { type: "string", required: true },
            },
          },
        },
        {
          second: {
            modelName: "second",
            tableName: "second",
            primaryKey: ["id"],
            indexes: [{ name: "idx_duplicate", fields: ["id"] }],
            fields: {
              id: { type: "string", required: true },
            },
          },
        },
      ),
    ).toThrow('Duplicate storage index "idx_duplicate" for first and second');
  });

  it("rejects invalid references", () => {
    expect(() =>
      mergeSchemas(
        {
          tools: {
            modelName: "tools",
            tableName: "tools",
            primaryKey: ["id"],
            fields: {
              id: { type: "string", required: true },
            },
          },
        },
        {
          broken: {
            modelName: "broken",
            tableName: "broken",
            primaryKey: ["id"],
            fields: {
              id: { type: "string", required: true },
              toolId: {
                type: "string",
                references: {
                  model: "tools",
                  field: "missing",
                },
              },
            },
          },
        },
      ),
    ).toThrow('Field "broken.toolId" references missing field "tools.missing"');
  });
});
