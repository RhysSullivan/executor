import { describe, test, expect } from "bun:test";
import { jsonSchemaToTypeString, jsonSchemaToZod, type JsonSchema } from "./json-schema-to-ts.js";

describe("jsonSchemaToTypeString", () => {
  test("primitives", () => {
    expect(jsonSchemaToTypeString({ type: "string" })).toBe("string");
    expect(jsonSchemaToTypeString({ type: "number" })).toBe("number");
    expect(jsonSchemaToTypeString({ type: "integer" })).toBe("number");
    expect(jsonSchemaToTypeString({ type: "boolean" })).toBe("boolean");
    expect(jsonSchemaToTypeString({ type: "null" })).toBe("null");
  });

  test("object with properties", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };
    const result = jsonSchemaToTypeString(schema);
    expect(result).toContain("name: string");
    expect(result).toContain("age?: number");
  });

  test("object with no properties", () => {
    const result = jsonSchemaToTypeString({ type: "object" });
    expect(result).toBe("Record<string, unknown>");
  });

  test("array", () => {
    const schema: JsonSchema = {
      type: "array",
      items: { type: "string" },
    };
    expect(jsonSchemaToTypeString(schema)).toBe("Array<string>");
  });

  test("enum", () => {
    const schema: JsonSchema = {
      enum: ["a", "b", "c"],
    };
    expect(jsonSchemaToTypeString(schema)).toBe('"a" | "b" | "c"');
  });

  test("nested objects", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
      required: ["user"],
    };
    const result = jsonSchemaToTypeString(schema);
    expect(result).toContain("user: {");
    expect(result).toContain("name: string");
  });

  test("implicit object (no type but has properties)", () => {
    const schema: JsonSchema = {
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    };
    const result = jsonSchemaToTypeString(schema);
    expect(result).toContain("query: string");
  });
});

describe("jsonSchemaToZod", () => {
  test("string validates correctly", () => {
    const schema = jsonSchemaToZod({ type: "string" });
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse(123).success).toBe(false);
  });

  test("number validates correctly", () => {
    const schema = jsonSchemaToZod({ type: "number" });
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse("hello").success).toBe(false);
  });

  test("object with required fields", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });

    expect(schema.safeParse({ name: "Alice" }).success).toBe(true);
    expect(schema.safeParse({ name: "Alice", age: 30 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // missing required 'name'
  });

  test("array of strings", () => {
    const schema = jsonSchemaToZod({
      type: "array",
      items: { type: "string" },
    });

    expect(schema.safeParse(["a", "b"]).success).toBe(true);
    expect(schema.safeParse([1, 2]).success).toBe(false);
  });

  test("enum", () => {
    const schema = jsonSchemaToZod({
      enum: ["a", "b", "c"],
    });

    expect(schema.safeParse("a").success).toBe(true);
    expect(schema.safeParse("d").success).toBe(false);
  });
});
