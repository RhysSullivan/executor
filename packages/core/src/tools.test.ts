import { describe, test, expect } from "bun:test";
import { z } from "zod";
import {
  defineTool,
  isToolDefinition,
  walkToolTree,
  mergeToolTrees,
  type ToolTree,
} from "./tools.js";

describe("defineTool", () => {
  test("creates a tool with _tag", () => {
    const tool = defineTool({
      description: "Add two numbers",
      approval: "auto",
      args: z.object({ a: z.number(), b: z.number() }),
      returns: z.number(),
      run: async (input) => input.a + input.b,
    });

    expect(tool._tag).toBe("ToolDefinition");
    expect(tool.description).toBe("Add two numbers");
    expect(tool.approval).toBe("auto");
  });

  test("run function works", async () => {
    const tool = defineTool({
      description: "Add",
      approval: "auto",
      args: z.object({ a: z.number(), b: z.number() }),
      returns: z.number(),
      run: async (input) => input.a + input.b,
    });

    expect(await tool.run({ a: 1, b: 2 })).toBe(3);
  });
});

describe("isToolDefinition", () => {
  test("identifies tool definitions", () => {
    const tool = defineTool({
      description: "test",
      approval: "auto",
      args: z.object({}),
      returns: z.void(),
      run: async () => {},
    });

    expect(isToolDefinition(tool)).toBe(true);
    expect(isToolDefinition({ _tag: "ToolDefinition" })).toBe(true);
    expect(isToolDefinition({})).toBe(false);
    expect(isToolDefinition(null)).toBe(false);
    expect(isToolDefinition("string")).toBe(false);
  });
});

describe("walkToolTree", () => {
  test("walks flat tree", () => {
    const add = defineTool({
      description: "add",
      approval: "auto",
      args: z.object({ a: z.number(), b: z.number() }),
      returns: z.number(),
      run: async (input) => input.a + input.b,
    });

    const paths: string[] = [];
    walkToolTree({ add }, (path) => paths.push(path));

    expect(paths).toEqual(["add"]);
  });

  test("walks nested tree", () => {
    const tool = defineTool({
      description: "test",
      approval: "auto",
      args: z.object({}),
      returns: z.void(),
      run: async () => {},
    });

    const tree: ToolTree = {
      github: {
        issues: {
          list: tool,
          close: tool,
        },
      },
      calendar: {
        update: tool,
      },
    };

    const paths: string[] = [];
    walkToolTree(tree, (path) => paths.push(path));

    expect(paths.sort()).toEqual([
      "calendar.update",
      "github.issues.close",
      "github.issues.list",
    ]);
  });
});

describe("mergeToolTrees", () => {
  test("merges non-overlapping trees", () => {
    const tool = defineTool({
      description: "test",
      approval: "auto",
      args: z.object({}),
      returns: z.void(),
      run: async () => {},
    });

    const a: ToolTree = { github: { list: tool } };
    const b: ToolTree = { calendar: { update: tool } };
    const merged = mergeToolTrees(a, b);

    const paths: string[] = [];
    walkToolTree(merged, (path) => paths.push(path));

    expect(paths.sort()).toEqual(["calendar.update", "github.list"]);
  });

  test("merges overlapping sub-trees", () => {
    const tool = defineTool({
      description: "test",
      approval: "auto",
      args: z.object({}),
      returns: z.void(),
      run: async () => {},
    });

    const a: ToolTree = { github: { issues: { list: tool } } };
    const b: ToolTree = { github: { issues: { close: tool } } };
    const merged = mergeToolTrees(a, b);

    const paths: string[] = [];
    walkToolTree(merged, (path) => paths.push(path));

    expect(paths.sort()).toEqual(["github.issues.close", "github.issues.list"]);
  });
});
