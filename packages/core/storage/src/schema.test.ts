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
  it("merges schemas and composes plugin schemas", () => {
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

  describe("field additions to existing models", () => {
    const base = {
      tools: {
        modelName: "tools",
        tableName: "tools",
        primaryKey: ["id", "scopeId"],
        fields: {
          id: { type: "string", required: true },
          scopeId: { type: "string", columnName: "scope_id", required: true },
          name: { type: "string", required: true },
        },
      },
    } as const satisfies Record<string, import("./schema").ExecutorModelSchema>;

    it("unions fields when the same model is contributed twice", () => {
      const addition = {
        tools: {
          modelName: "tools",
          tableName: "tools",
          primaryKey: ["id", "scopeId"],
          fields: {
            extraField: { type: "string" },
          },
          indexes: [{ name: "idx_tools_extra", fields: ["extraField"] }],
        },
      } as const;

      const merged = mergeSchemas(base, addition);
      expect(merged.tools?.fields.extraField?.type).toBe("string");
      expect(merged.tools?.fields.name?.required).toBe(true);
      expect(merged.tools?.indexes).toEqual([{ name: "idx_tools_extra", fields: ["extraField"] }]);
    });

    it("rejects duplicate field names across contributors", () => {
      const addition = {
        tools: {
          modelName: "tools",
          tableName: "tools",
          primaryKey: ["id", "scopeId"],
          fields: {
            name: { type: "string" },
          },
        },
      } as const;

      expect(() => mergeSchemas(base, addition)).toThrow(/already has field "name"/);
    });

    it("rejects required field additions", () => {
      const addition = {
        tools: {
          modelName: "tools",
          tableName: "tools",
          primaryKey: ["id", "scopeId"],
          fields: {
            criticalField: { type: "string", required: true },
          },
        },
      } as const;

      expect(() => mergeSchemas(base, addition)).toThrow(/added fields must be optional/);
    });

    it("rejects conflicting tableName across contributors", () => {
      const addition = {
        tools: {
          modelName: "tools",
          tableName: "tools_v2",
          primaryKey: ["id", "scopeId"],
          fields: {
            extraField: { type: "string" },
          },
        },
      } as const;

      expect(() => mergeSchemas(base, addition)).toThrow(/conflicting tableName/);
    });

    it("rejects conflicting primaryKey across contributors", () => {
      const addition = {
        tools: {
          modelName: "tools",
          tableName: "tools",
          primaryKey: ["id"],
          fields: {
            extraField: { type: "string" },
          },
        },
      } as const;

      expect(() => mergeSchemas(base, addition)).toThrow(/conflicting primaryKey/);
    });
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
