// Regression test: circular `$ref`s in a spec must not hang the parser or
// extractor, and must still yield a usable ExtractionResult. Before the
// move to @readme/openapi-parser our hand-rolled walker could recurse
// indefinitely on self-referential schemas (e.g. a tree / linked-list
// node pattern that's common in real APIs).

import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { parse } from "./parse";
import { extract } from "./extract";

const circularSpec = {
  openapi: "3.0.0",
  info: { title: "Circular", version: "1.0.0" },
  paths: {
    "/trees": {
      get: {
        operationId: "listTrees",
        responses: {
          "200": {
            description: "A tree node",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TreeNode" },
              },
            },
          },
        },
      },
      post: {
        operationId: "createTree",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TreeNode" },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TreeNode" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      TreeNode: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          // Direct self-cycle
          parent: { $ref: "#/components/schemas/TreeNode" },
          // Indirect cycle: TreeNode → children → items → TreeNode
          children: {
            type: "array",
            items: { $ref: "#/components/schemas/TreeNode" },
          },
        },
      },
    },
  },
};

// Mutual-recursion cycle across two schemas — a harder case than direct
// self-reference because the walker has to track visited nodes across
// multiple shapes.
const mutualSpec = {
  openapi: "3.0.0",
  info: { title: "Mutual", version: "1.0.0" },
  paths: {
    "/a": {
      get: {
        operationId: "getA",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/A" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      A: {
        type: "object",
        properties: { b: { $ref: "#/components/schemas/B" } },
      },
      B: {
        type: "object",
        properties: { a: { $ref: "#/components/schemas/A" } },
      },
    },
  },
};

describe("Circular $ref handling", { timeout: 2_000 }, () => {
  it.effect("parses a directly self-referential schema without hanging", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(circularSpec));
      expect(doc).toBeDefined();
      expect(doc.components).toBeDefined();
    }),
  );

  it.effect("extracts operations when schemas contain cycles", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(circularSpec));
      const result = yield* extract(doc);

      expect(result.operations).toHaveLength(2);

      const listTrees = result.operations.find((op) => op.operationId === "listTrees");
      expect(listTrees).toBeDefined();
      expect(Option.isSome(listTrees!.outputSchema)).toBe(true);

      const createTree = result.operations.find((op) => op.operationId === "createTree");
      expect(createTree).toBeDefined();
      expect(Option.isSome(createTree!.requestBody)).toBe(true);
    }),
  );

  it.effect("parses mutually-recursive schemas without hanging", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(mutualSpec));
      const result = yield* extract(doc);
      expect(result.operations).toHaveLength(1);

      const getA = result.operations[0]!;
      expect(getA.operationId).toBe("getA");
      expect(Option.isSome(getA.outputSchema)).toBe(true);
    }),
  );

  it.effect("preserves cycles via object identity in the resolved tree", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const doc = yield* parse(JSON.stringify(circularSpec));

      // @readme/openapi-parser replaces $ref objects with the resolved
      // target. For a direct self-cycle, the target === the parent schema.
      const schemas = doc.components?.schemas as Record<string, unknown> | undefined;
      expect(schemas).toBeDefined();
      const tree = schemas!.TreeNode as {
        properties: { parent: unknown; children: { items: unknown } };
      };
      // parent points back to the TreeNode object itself
      expect(tree.properties.parent).toBe(tree);
      // children.items also points back to the TreeNode object
      expect(tree.properties.children.items).toBe(tree);
    }),
  );
});
