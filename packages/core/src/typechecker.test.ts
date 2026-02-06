import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { defineTool, type ToolTree } from "./tools.js";
import {
  zodToTypeString,
  generateToolDeclarations,
  generatePromptGuidance,
  typecheckCode,
} from "./typechecker.js";

describe("zodToTypeString", () => {
  test("primitives", () => {
    expect(zodToTypeString(z.string())).toBe("string");
    expect(zodToTypeString(z.number())).toBe("number");
    expect(zodToTypeString(z.boolean())).toBe("boolean");
    expect(zodToTypeString(z.void())).toBe("void");
    expect(zodToTypeString(z.null())).toBe("null");
    expect(zodToTypeString(z.undefined())).toBe("undefined");
  });

  test("objects", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    expect(zodToTypeString(schema)).toBe("{ name: string; age: number }");
  });

  test("optional fields", () => {
    const schema = z.object({ name: z.string(), age: z.number().optional() });
    const result = zodToTypeString(schema);
    expect(result).toContain("name: string");
    expect(result).toContain("age?:");
  });

  test("arrays", () => {
    const schema = z.array(z.string());
    expect(zodToTypeString(schema)).toBe("Array<string>");
  });

  test("nested objects", () => {
    const schema = z.object({
      user: z.object({ name: z.string() }),
    });
    expect(zodToTypeString(schema)).toBe("{ user: { name: string } }");
  });

  test("enums", () => {
    const schema = z.enum(["a", "b", "c"]);
    expect(zodToTypeString(schema)).toBe('"a" | "b" | "c"');
  });

  test("records", () => {
    const schema = z.record(z.string(), z.number());
    expect(zodToTypeString(schema)).toBe("Record<string, number>");
  });
});

describe("generateToolDeclarations", () => {
  test("generates declarations for a tool tree", () => {
    const tree: ToolTree = {
      math: {
        add: defineTool({
          description: "Add two numbers",
          approval: "auto",
          args: z.object({ a: z.number(), b: z.number() }),
          returns: z.number(),
          run: async (input) => input.a + input.b,
        }),
      },
      github: {
        issues: {
          close: defineTool({
            description: "Close an issue",
            approval: "required",
            args: z.object({ owner: z.string(), repo: z.string(), issueNumber: z.number() }),
            returns: z.object({ state: z.string() }),
            run: async () => ({ state: "closed" }),
          }),
        },
      },
    };

    const declarations = generateToolDeclarations(tree);

    expect(declarations).toContain("declare const tools:");
    expect(declarations).toContain("add(input: { a: number; b: number }): Promise<number>;");
    expect(declarations).toContain("close(input: { owner: string; repo: string; issueNumber: number }): Promise<{ state: string }>;");
  });
});

describe("generatePromptGuidance", () => {
  test("generates guidance for tools", () => {
    const tree: ToolTree = {
      math: {
        add: defineTool({
          description: "Add two numbers",
          approval: "auto",
          args: z.object({ a: z.number(), b: z.number() }),
          returns: z.number(),
          run: async (input) => input.a + input.b,
        }),
      },
    };

    const guidance = generatePromptGuidance(tree);
    expect(guidance).toContain("tools.math.add");
    expect(guidance).toContain("Add two numbers");
    expect(guidance).toContain("auto-approved");
  });
});

describe("typecheckCode", () => {
  const tree: ToolTree = {
    math: {
      add: defineTool({
        description: "Add two numbers",
        approval: "auto",
        args: z.object({ a: z.number(), b: z.number() }),
        returns: z.number(),
        run: async (input) => input.a + input.b,
      }),
    },
  };

  const declarations = generateToolDeclarations(tree);

  test("valid code passes", () => {
    const result = typecheckCode(
      'const result = await tools.math.add({ a: 1, b: 2 });\nreturn result;',
      declarations,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("wrong argument type fails", () => {
    const result = typecheckCode(
      'const result = await tools.math.add({ a: "not a number", b: 2 });',
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("non-existent tool fails", () => {
    const result = typecheckCode(
      "const result = await tools.math.subtract({ a: 1, b: 2 });",
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("non-existent namespace fails", () => {
    const result = typecheckCode(
      'const result = await tools.calendar.create({ title: "test" });',
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
