import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  buildToolTypeScriptPreview,
  schemaToTypeScriptPreview,
  schemaToTypeScriptPreviewWithDefs,
} from "./schema-types";

const StripeBalanceTransactionsFixture = Schema.Struct({
  schema: Schema.Unknown,
  defs: Schema.Record(Schema.String, Schema.Unknown),
});

const stripeBalanceTransactionsFixture = Schema.decodeUnknownSync(
  Schema.fromJsonString(StripeBalanceTransactionsFixture),
)(
  readFileSync(
    new URL(
      "./__fixtures__/stripe-get-balance-transactions-id.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const sdkPackageRoot = fileURLToPath(new URL("..", import.meta.url));
const TypeScriptPreviewOutput = Schema.Struct({
  inputTypeScript: Schema.String,
  outputTypeScript: Schema.String,
});
const decodeTypeScriptPreviewOutput = Schema.decodeUnknownSync(
  Schema.fromJsonString(TypeScriptPreviewOutput),
);

describe("schema-types", () => {
  it("reuses referenced definitions instead of inlining them", async () => {
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

    const preview = await schemaToTypeScriptPreview(schema);
    expect(preview.definitions).toEqual({});
    expect(preview.type).toContain("export interface SchemaPreview");
    expect(preview.type).toContain("__root");
    expect(preview.type).toContain("homeAddress: Address");
    expect(preview.type).toContain("workAddress: Address");
    expect(preview.type).toContain("export interface Address");
  });

  it("can render against shared definitions provided externally", async () => {
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

    const preview = await schemaToTypeScriptPreviewWithDefs(schema, defs);
    expect(preview.definitions).toEqual({});
    expect(preview.type).toContain("headquarters: Address");
    expect(preview.type).toContain("export interface Address");
    expect(preview.type).toContain("city: string");
  });

  it("renders transitive referenced definitions", async () => {
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

    const preview = await schemaToTypeScriptPreviewWithDefs(
      {
        $ref: "#/$defs/LevelOne",
      },
      defs,
    );
    expect(preview.definitions).toEqual({});
    expect(preview.type).toContain("__root: LevelOne");
    expect(preview.type).toContain("export interface LevelOne");
    expect(preview.type).toContain("next: LevelTwo");
    expect(preview.type).toContain("export interface LevelFour");
  });

  it("keeps ordinary unions expanded", async () => {
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

    const preview = await schemaToTypeScriptPreviewWithDefs(
      {
        $ref: "#/$defs/Pet",
      },
      defs,
    );
    expect(preview.definitions).toEqual({});
    expect(preview.type).toContain("export type Pet = (Dog | Cat | Lizard)");
    expect(preview.type).toContain("__root: Pet");
    expect(preview.type).toContain("export interface Dog");
  });

  it("renders large unions from real Stripe fixtures", async () => {
    const defs = new Map(Object.entries(stripeBalanceTransactionsFixture.defs));

    const preview = await schemaToTypeScriptPreviewWithDefs(
      stripeBalanceTransactionsFixture.schema,
      defs,
    );

    expect(preview.definitions).toEqual({});
    expect(preview.type).toContain("__root: BalanceTransaction");
    expect(preview.type).toContain("export interface BalanceTransaction");
    expect(preview.type).toContain("fee_details: Fee[]");
    expect(preview.type).toContain("source: (string | Polymorphic | null)");
    expect(preview.type).toContain("export interface Fee");
    expect(preview.type).toContain("export type Polymorphic =");
    expect(preview.type).toContain("Charge");
    expect(preview.type).toContain("Refund");
    expect(preview.type).toContain("Payout");
  });

  it("sanitizes dashed definition names and quotes dashed property keys", async () => {
    const preview = await schemaToTypeScriptPreview({
      type: "object",
      properties: {
        "dash-prop": { type: ["string", "null"] },
        child: { $ref: "#/$defs/foo-bar" },
      },
      required: ["dash-prop", "child"],
      additionalProperties: false,
      $defs: {
        "foo-bar": {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    });

    expect(preview.definitions).toEqual({});
    expect(preview.type).toContain('"dash-prop": (string | null)');
    expect(preview.type).toContain("child: FooBar");
    expect(preview.type).toContain("export interface FooBar");
    expect(preview.definitions).not.toHaveProperty("foo-bar");
  });

  it("normalizes OpenAPI nullable schemas before compiling", async () => {
    const preview = await schemaToTypeScriptPreview({
      type: "object",
      properties: {
        maybeObject: {
          type: "object",
          nullable: true,
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        maybeEnum: {
          enum: ["created", "updated"],
          nullable: true,
        },
        maybeConst: {
          const: "ok",
          nullable: true,
        },
      },
      required: ["maybeObject", "maybeEnum", "maybeConst"],
      additionalProperties: false,
    });

    expect(preview.type).toContain("maybeObject: ({");
    expect(preview.type).toContain("} | null)");
    expect(preview.type).toContain('maybeEnum: ("created" | "updated" | null)');
    expect(preview.type).toContain('maybeConst: ("ok" | null)');
  });

  it("handles recursive refs through the compiler wrapper", async () => {
    const preview = await schemaToTypeScriptPreview({
      $ref: "#/$defs/IssueFilter",
      $defs: {
        IssueFilter: {
          type: "object",
          properties: {
            and: {
              type: "array",
              items: { $ref: "#/$defs/IssueFilter" },
            },
          },
          additionalProperties: false,
        },
      },
    });

    expect(preview.definitions).toEqual({});
    expect(preview.type).toContain("__root: IssueFilter");
    expect(preview.type).toContain("export interface IssueFilter");
    expect(preview.type).toContain("and?: IssueFilter[]");
  });

  it("merges input and output TypeScript definitions", async () => {
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

    const preview = await buildToolTypeScriptPreview({
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
    });
    expect(preview.typeScriptDefinitions).toBeUndefined();
    expect(preview.inputTypeScript).toContain("export interface Input");
    expect(preview.inputTypeScript).toContain("address: Address");
    expect(preview.outputTypeScript).toContain("export interface Output");
    expect(preview.outputTypeScript).toContain("__root: Contact");
    expect(preview.outputTypeScript).toContain("export interface Contact");
  });

  it("loads the vendored compiler through Bun's TypeScript loader", () => {
    const output = execFileSync(
      "bun",
      [
        "-e",
        `
          import { buildToolTypeScriptPreview } from "./src/schema-types.ts";
          const preview = await buildToolTypeScriptPreview({
            inputSchema: {
              type: "object",
              properties: {
                account_id: { type: "string" },
                body: {}
              },
              required: ["account_id", "body"],
              additionalProperties: false
            },
            outputSchema: {},
            defs: new Map()
          });
          console.log(JSON.stringify(preview));
        `,
      ],
      { cwd: sdkPackageRoot, encoding: "utf8" },
    );

    const preview = decodeTypeScriptPreviewOutput(output);
    expect(preview.inputTypeScript).toContain("export interface Input");
    expect(preview.inputTypeScript).toContain("account_id: string");
    expect(preview.inputTypeScript).toContain("body: unknown");
    expect(preview.outputTypeScript).toContain("export interface Output");
    expect(preview.outputTypeScript).toContain("__root: unknown");
  });
});
