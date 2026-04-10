import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { extract } from "./extract";
import type { IntrospectionResult } from "./introspect";

// ---------------------------------------------------------------------------
// Minimal introspection fixture
// ---------------------------------------------------------------------------

const makeIntrospection = (
  overrides?: Partial<IntrospectionResult["__schema"]>,
): IntrospectionResult => ({
  __schema: {
    queryType: { name: "Query" },
    mutationType: { name: "Mutation" },
    types: [
      {
        kind: "OBJECT",
        name: "Query",
        description: null,
        fields: [
          {
            name: "user",
            description: "Fetch a user by ID",
            args: [
              {
                name: "id",
                description: "User ID",
                type: {
                  kind: "NON_NULL",
                  name: null,
                  ofType: { kind: "SCALAR", name: "ID", ofType: null },
                },
                defaultValue: null,
              },
            ],
            type: { kind: "OBJECT", name: "User", ofType: null },
          },
          {
            name: "users",
            description: "List all users",
            args: [],
            type: {
              kind: "NON_NULL",
              name: null,
              ofType: {
                kind: "LIST",
                name: null,
                ofType: { kind: "OBJECT", name: "User", ofType: null },
              },
            },
          },
        ],
        inputFields: null,
        enumValues: null,
      },
      {
        kind: "OBJECT",
        name: "Mutation",
        description: null,
        fields: [
          {
            name: "createUser",
            description: "Create a new user",
            args: [
              {
                name: "name",
                description: null,
                type: {
                  kind: "NON_NULL",
                  name: null,
                  ofType: { kind: "SCALAR", name: "String", ofType: null },
                },
                defaultValue: null,
              },
              {
                name: "email",
                description: null,
                type: { kind: "SCALAR", name: "String", ofType: null },
                defaultValue: null,
              },
            ],
            type: { kind: "OBJECT", name: "User", ofType: null },
          },
        ],
        inputFields: null,
        enumValues: null,
      },
      {
        kind: "OBJECT",
        name: "User",
        description: null,
        fields: [
          {
            name: "id",
            description: null,
            args: [],
            type: {
              kind: "NON_NULL",
              name: null,
              ofType: { kind: "SCALAR", name: "ID", ofType: null },
            },
          },
          {
            name: "name",
            description: null,
            args: [],
            type: { kind: "SCALAR", name: "String", ofType: null },
          },
          {
            name: "email",
            description: null,
            args: [],
            type: { kind: "SCALAR", name: "String", ofType: null },
          },
        ],
        inputFields: null,
        enumValues: null,
      },
      {
        kind: "SCALAR",
        name: "ID",
        description: null,
        fields: null,
        inputFields: null,
        enumValues: null,
      },
      {
        kind: "SCALAR",
        name: "String",
        description: null,
        fields: null,
        inputFields: null,
        enumValues: null,
      },
      {
        kind: "SCALAR",
        name: "Boolean",
        description: null,
        fields: null,
        inputFields: null,
        enumValues: null,
      },
    ],
    ...overrides,
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extract", () => {
  it("extracts queries and mutations from introspection result", async () => {
    const { result } = await Effect.runPromise(extract(makeIntrospection()));

    const queries = result.fields.filter((f) => f.kind === "query");
    const mutations = result.fields.filter((f) => f.kind === "mutation");

    expect(queries).toHaveLength(2);
    expect(mutations).toHaveLength(1);

    const userQuery = queries.find((f) => f.fieldName === "user");
    expect(userQuery).toBeDefined();
    expect(userQuery!.arguments).toHaveLength(1);
    expect(userQuery!.arguments[0].name).toBe("id");
    expect(userQuery!.arguments[0].required).toBe(true);
    expect(userQuery!.returnTypeName).toBe("User");

    const createMutation = mutations.find((f) => f.fieldName === "createUser");
    expect(createMutation).toBeDefined();
    expect(createMutation!.arguments).toHaveLength(2);
    expect(createMutation!.arguments[0].name).toBe("name");
    expect(createMutation!.arguments[0].required).toBe(true);
    expect(createMutation!.arguments[1].name).toBe("email");
    expect(createMutation!.arguments[1].required).toBe(false);
  });

  it("builds input schema with required fields", async () => {
    const { result } = await Effect.runPromise(extract(makeIntrospection()));
    const createUser = result.fields.find((f) => f.fieldName === "createUser");
    expect(createUser).toBeDefined();

    const inputSchema = createUser!.inputSchema as any;
    expect(inputSchema.value).toBeDefined();
    const schema = inputSchema.value;
    expect(schema.type).toBe("object");
    expect(schema.properties.name.type).toBe("string");
    expect(schema.required).toContain("name");
    expect(schema.required).not.toContain("email");
  });

  it("handles schema with no mutations", async () => {
    const { result } = await Effect.runPromise(extract(makeIntrospection({ mutationType: null })));

    const mutations = result.fields.filter((f) => f.kind === "mutation");
    expect(mutations).toHaveLength(0);
  });

  it("handles empty query type", async () => {
    const { result } = await Effect.runPromise(extract(makeIntrospection({ queryType: null })));

    const queries = result.fields.filter((f) => f.kind === "query");
    expect(queries).toHaveLength(0);
  });

  it("handles circular input type references without stack overflow", async () => {
    const circular: IntrospectionResult = {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            description: null,
            fields: [
              {
                name: "issues",
                description: "List issues",
                args: [
                  {
                    name: "filter",
                    description: null,
                    type: { kind: "INPUT_OBJECT", name: "IssueFilter", ofType: null },
                    defaultValue: null,
                  },
                ],
                type: { kind: "OBJECT", name: "Issue", ofType: null },
              },
            ],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "INPUT_OBJECT",
            name: "IssueFilter",
            description: null,
            fields: null,
            inputFields: [
              {
                name: "title",
                description: null,
                type: { kind: "SCALAR", name: "String", ofType: null },
                defaultValue: null,
              },
              {
                name: "and",
                description: "Compound filter",
                type: {
                  kind: "LIST",
                  name: null,
                  ofType: { kind: "INPUT_OBJECT", name: "IssueFilter", ofType: null },
                },
                defaultValue: null,
              },
              {
                name: "or",
                description: null,
                type: {
                  kind: "LIST",
                  name: null,
                  ofType: { kind: "INPUT_OBJECT", name: "IssueFilter", ofType: null },
                },
                defaultValue: null,
              },
            ],
            enumValues: null,
          },
          {
            kind: "OBJECT",
            name: "Issue",
            description: null,
            fields: [
              {
                name: "id",
                description: null,
                args: [],
                type: { kind: "SCALAR", name: "ID", ofType: null },
              },
            ],
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "SCALAR",
            name: "String",
            description: null,
            fields: null,
            inputFields: null,
            enumValues: null,
          },
          {
            kind: "SCALAR",
            name: "ID",
            description: null,
            fields: null,
            inputFields: null,
            enumValues: null,
          },
        ],
      },
    };

    // Should not throw "Maximum call stack size exceeded"
    const { result, definitions } = await Effect.runPromise(extract(circular));
    expect(result.fields).toHaveLength(1);

    const issuesField = result.fields[0];
    expect(issuesField.fieldName).toBe("issues");

    // The filter arg should use a $ref, not inline the full type
    const schema = (issuesField.inputSchema as any).value;
    expect(schema.properties.filter.$ref).toBe("#/$defs/IssueFilter");

    // The definition should exist with proper fields
    const filterDef = definitions["IssueFilter"] as any;
    expect(filterDef.type).toBe("object");
    expect(filterDef.properties.title.type).toBe("string");
    // Self-referential "and" field uses $ref back to itself
    expect(filterDef.properties.and.type).toBe("array");
    expect(filterDef.properties.and.items.$ref).toBe("#/$defs/IssueFilter");
  });
});
