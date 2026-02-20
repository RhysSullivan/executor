import { describe, expect, test } from "bun:test";
import {
  fsReadInputSchema,
  kvSetInputSchema,
  sqliteQueryInputSchema,
  storageOpenInputSchema,
  storageOpenInputJsonSchema,
  sqliteInsertRowsInputJsonSchema,
} from "./storage_tool_contracts";

describe("storage tool contracts", () => {
  test("parses canonical tool inputs", () => {
    expect(storageOpenInputSchema.parse({})).toEqual({});
    expect(fsReadInputSchema.parse({ path: "/notes.txt" }).path).toBe("/notes.txt");
    expect(kvSetInputSchema.parse({ key: "answer", value: 42 }).value).toBe(42);
    expect(sqliteQueryInputSchema.parse({ sql: "SELECT 1" }).sql).toBe("SELECT 1");
  });

  test("exports json schemas for discovery typing", () => {
    expect(storageOpenInputJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });

    expect(sqliteInsertRowsInputJsonSchema).toMatchObject({
      type: "object",
      required: ["table", "columns", "rows"],
    });
  });
});
