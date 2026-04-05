import { describe, expect, it } from "@effect/vitest";

import {
  buildToolTypeScriptPreview,
  schemaToTypeScriptPreview,
  schemaToTypeScriptPreviewWithDefs,
} from "./schema-types";

describe("schema-types", () => {
  it("reuses referenced definitions instead of inlining them", () => {
    const schema = {
      type: "object",
      properties: {
        homeAddress: { $ref: "#/$defs/Address" },
        workAddress: { $ref: "#/$defs/Address" },
      },
      required: ["homeAddress", "workAddress"],
      additionalProperties: false,
      $defs: {
        Address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
            zip: { type: "string" },
          },
          required: ["street", "city", "zip"],
          additionalProperties: false,
        },
      },
    };

    expect(schemaToTypeScriptPreview(schema)).toEqual({
      type: "{ homeAddress: Address; workAddress: Address }",
      definitions: {
        Address: "{ street: string; city: string; zip: string }",
      },
    });
  });

  it("can render against shared definitions provided externally", () => {
    const schema = {
      type: "object",
      properties: {
        headquarters: { $ref: "#/$defs/Address" },
      },
      required: ["headquarters"],
      additionalProperties: false,
    };

    const defs = new Map<string, unknown>([
      [
        "Address",
        {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      ],
    ]);

    expect(schemaToTypeScriptPreviewWithDefs(schema, defs)).toEqual({
      type: "{ headquarters: Address }",
      definitions: {
        Address: "{ city: string }",
      },
    });
  });

  it("merges input and output TypeScript definitions", () => {
    const defs = new Map<string, unknown>([
      [
        "Address",
        {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
          additionalProperties: false,
        },
      ],
      [
        "Contact",
        {
          type: "object",
          properties: {
            id: { type: "string" },
            address: { $ref: "#/$defs/Address" },
          },
          required: ["id", "address"],
          additionalProperties: false,
        },
      ],
    ]);

    expect(
      buildToolTypeScriptPreview({
        inputSchema: {
          type: "object",
          properties: {
            address: { $ref: "#/$defs/Address" },
          },
          required: ["address"],
          additionalProperties: false,
        },
        outputSchema: {
          $ref: "#/$defs/Contact",
        },
        defs,
      }),
    ).toEqual({
      inputTypeScript: "{ address: Address }",
      outputTypeScript: "Contact",
      typeScriptDefinitions: {
        Address: "{ city: string }",
        Contact: "{ id: string; address: Address }",
      },
    });
  });
});
