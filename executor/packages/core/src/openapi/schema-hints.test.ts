import { expect, test } from "bun:test";
import { jsonSchemaTypeHintFallback } from "./schema-hints";

test("jsonSchemaTypeHintFallback collapses simple oneOf object union", () => {
  const schema = {
    oneOf: [
      {
        type: "object",
        properties: {
          uid: { type: "string" },
          updated: { type: "number" },
        },
        required: ["uid", "updated"],
      },
      {
        type: "object",
        properties: {
          uid: { type: "string" },
        },
        required: ["uid"],
      },
    ],
  };

  expect(jsonSchemaTypeHintFallback(schema)).toBe("{ uid: string; updated?: number }");
});

test("jsonSchemaTypeHintFallback factors common object fields in oneOf", () => {
  const schema = {
    oneOf: [
      {
        type: "object",
        properties: {
          domain: { type: "string" },
          type: { enum: ["A"] },
          value: { type: "string" },
        },
        required: ["domain", "type", "value"],
      },
      {
        type: "object",
        properties: {
          domain: { type: "string" },
          type: { enum: ["AAAA"] },
          value: { type: "string" },
        },
        required: ["domain", "type", "value"],
      },
    ],
  };

  const hint = jsonSchemaTypeHintFallback(schema);
  expect(hint).toContain("domain: string");
  expect(hint).toContain("value: string");
  // Variants only differ by the discriminant; they should be merged.
  expect(hint).toContain("type: \"A\" | \"AAAA\"");
});

test("jsonSchemaTypeHintFallback parenthesizes union inside intersection", () => {
  const schema = {
    allOf: [
      {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
      },
      {
        oneOf: [
          { type: "object", properties: { type: { enum: ["A"] }, value: { type: "string" } }, required: ["type", "value"] },
          { type: "object", properties: { type: { enum: ["B"] }, id: { type: "number" } }, required: ["type", "id"] },
        ],
      },
    ],
  };

  const hint = jsonSchemaTypeHintFallback(schema);
  expect(hint).toContain("& (");
  expect(hint).toContain("| ");
});

test("jsonSchemaTypeHintFallback inlines small component schema refs at depth threshold", () => {
  const componentSchemas = {
    Pagination: {
      type: "object",
      properties: {
        count: { type: "number" },
        next: { type: "number", nullable: true },
        prev: { type: "number", nullable: true },
      },
      required: ["count", "next", "prev"],
    },
  };

  const hint = jsonSchemaTypeHintFallback(
    { $ref: "#/components/schemas/Pagination" },
    2,
    componentSchemas,
  );
  expect(hint).toContain("count");
  expect(hint).not.toContain("components[\"schemas\"][\"Pagination\"]");
});

test("jsonSchemaTypeHintFallback drops plain scalar variants when union has multiple object shapes", () => {
  const schema = {
    oneOf: [
      { type: "string" },
      {
        type: "object",
        properties: {
          records: { type: "string" },
        },
        required: ["records"],
      },
      {
        type: "object",
        properties: {
          records: { type: "string" },
          pagination: { type: "number" },
        },
        required: ["records", "pagination"],
      },
    ],
  };

  // string variant is pruned; remaining two objects collapse into optional pagination.
  expect(jsonSchemaTypeHintFallback(schema)).toBe("{ records: string; pagination?: number }");
});

test("jsonSchemaTypeHintFallback drops empty object variant when a more specific object is present", () => {
  const schema = {
    oneOf: [
      { type: "object" },
      {
        type: "object",
        properties: {
          a: { type: "string" },
        },
        required: ["a"],
      },
    ],
  };

  expect(jsonSchemaTypeHintFallback(schema)).toBe("{ a: string }");
});

test("jsonSchemaTypeHintFallback keeps scalar | object when union has only one object variant", () => {
  const schema = {
    oneOf: [
      { type: "string" },
      {
        type: "object",
        properties: {
          a: { type: "string" },
        },
        required: ["a"],
      },
    ],
  };

  expect(jsonSchemaTypeHintFallback(schema)).toBe("string | { a: string }");
});

test("jsonSchemaTypeHintFallback partially factors repeated required keys from large unions", () => {
  const schema = {
    oneOf: [
      {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { enum: ["A"] },
          value: { type: "string" },
        },
        required: ["name", "type", "value"],
      },
      {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { enum: ["AAAA"] },
          value: { type: "string" },
        },
        required: ["name", "type", "value"],
      },
      {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { enum: ["CNAME"] },
          value: { type: "string" },
        },
        required: ["name", "type"],
      },
      {
        type: "object",
        properties: {
          type: { enum: ["SRV"] },
          srv: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
        },
        required: ["type", "srv"],
      },
    ],
  };

  const hint = jsonSchemaTypeHintFallback(schema);
  // `name` should only appear once after factoring.
  expect(hint.split("name: string").length - 1).toBe(1);
  // Still must mention SRV variant.
  expect(hint).toContain("type: \"SRV\"");
  // The factored form uses an intersection.
  expect(hint).toContain("& (");
});

test("jsonSchemaTypeHintFallback factors common fields and then partially factors repeated keys inside residual union", () => {
  const schema = {
    anyOf: [
      {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { enum: ["A"] },
          value: { type: "string" },
          ttl: { type: "number" },
          comment: { type: "string" },
        },
        required: ["name", "type", "value"],
      },
      {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { enum: ["AAAA"] },
          value: { type: "string" },
          ttl: { type: "number" },
          comment: { type: "string" },
        },
        required: ["name", "type", "value"],
      },
      {
        type: "object",
        properties: {
          type: { enum: ["SRV"] },
          srv: {
            type: "object",
            properties: { target: { type: "string" } },
            required: ["target"],
          },
          ttl: { type: "number" },
          comment: { type: "string" },
        },
        required: ["type", "srv"],
      },
      {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { enum: ["NS"] },
          value: { type: "string" },
          ttl: { type: "number" },
          comment: { type: "string" },
        },
        required: ["name", "type"],
      },
    ],
  };

  const hint = jsonSchemaTypeHintFallback(schema);
  // `ttl`/`comment` appear once as common fields.
  expect(hint.split("ttl?: number").length - 1).toBe(1);
  expect(hint.split("comment?: string").length - 1).toBe(1);
  // `name` should also be factored once inside the residual union.
  expect(hint.split("name: string").length - 1).toBe(1);
});

test("jsonSchemaTypeHintFallback merges discriminated object variants that only differ by type enum", () => {
  const schema = {
    oneOf: [
      {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["A"] },
          value: { type: "string" },
        },
        required: ["name", "type", "value"],
      },
      {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["AAAA"] },
          value: { type: "string" },
        },
        required: ["name", "type", "value"],
      },
    ],
  };

  const hint = jsonSchemaTypeHintFallback(schema);
  expect(hint).toContain("name: string");
  expect(hint).toContain("value: string");
  expect(hint).toContain("type: \"A\" | \"AAAA\"");
  // Should not render as two separate object variants.
  expect(hint).not.toContain("type: \"A\"; value");
  expect(hint).not.toContain("type: \"AAAA\"; value");
});
