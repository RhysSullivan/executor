import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";

import {
  buildToolTypeScriptPreview,
  schemaToTypeScriptPreview,
  schemaToTypeScriptPreviewWithDefs,
} from "./schema-types";

const stripeBalanceTransactionsFixture = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/stripe-get-balance-transactions-id.json", import.meta.url),
    "utf8",
  ),
) as {
  schema: unknown;
  defs: Record<string, unknown>;
};

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

  it("limits referenced definitions to 3 levels and marks deeper refs as omitted", () => {
    const defs = new Map<string, unknown>([
      [
        "LevelOne",
        {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/LevelTwo" },
          },
          required: ["next"],
          additionalProperties: false,
        },
      ],
      [
        "LevelTwo",
        {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/LevelThree" },
          },
          required: ["next"],
          additionalProperties: false,
        },
      ],
      [
        "LevelThree",
        {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/LevelFour" },
          },
          required: ["next"],
          additionalProperties: false,
        },
      ],
      [
        "LevelFour",
        {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      ],
    ]);

    expect(
      schemaToTypeScriptPreviewWithDefs(
        {
          $ref: "#/$defs/LevelOne",
        },
        defs,
      ),
    ).toEqual({
      type: "LevelOne",
      definitions: {
        LevelOne: "{ next: LevelTwo }",
        LevelTwo: "{ next: LevelThree }",
        LevelThree: "{ next: unknown /* LevelFour omitted */ }",
      },
    });
  });

  it("keeps ordinary unions expanded when they stay under the composite threshold", () => {
    const defs = new Map<string, unknown>([
      [
        "Pet",
        {
          anyOf: [
            { $ref: "#/$defs/Dog" },
            { $ref: "#/$defs/Cat" },
            { $ref: "#/$defs/Lizard" },
          ],
        },
      ],
      [
        "Dog",
        {
          type: "object",
          properties: {
            bark: { type: "boolean" },
          },
          required: ["bark"],
          additionalProperties: false,
        },
      ],
      [
        "Cat",
        {
          type: "object",
          properties: {
            meow: { type: "boolean" },
          },
          required: ["meow"],
          additionalProperties: false,
        },
      ],
      [
        "Lizard",
        {
          type: "object",
          properties: {
            scales: { type: "boolean" },
          },
          required: ["scales"],
          additionalProperties: false,
        },
      ],
    ]);

    expect(
      schemaToTypeScriptPreviewWithDefs(
        {
          $ref: "#/$defs/Pet",
        },
        defs,
      ),
    ).toEqual({
      type: "Pet",
      definitions: {
        Cat: "{ meow: boolean }",
        Dog: "{ bark: boolean }",
        Lizard: "{ scales: boolean }",
        Pet: "Dog | Cat | Lizard",
      },
    });
  });

  it("summarizes large unions from real Stripe fixtures without pulling in the whole schema graph", () => {
    const defs = new Map(Object.entries(stripeBalanceTransactionsFixture.defs));

    expect(
      schemaToTypeScriptPreviewWithDefs(
        stripeBalanceTransactionsFixture.schema,
        defs,
      ),
    ).toEqual({
      type: "balance_transaction",
      definitions: {
        balance_transaction: expect.stringContaining("fee_details: fee[]"),
        balance_transaction_source: "unknown /* 16-way anyOf omitted */",
        fee: "{ amount: number; application: string | null; currency: string; description: string | null; type: string }",
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
