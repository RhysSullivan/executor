import { expect, test } from "bun:test";
import { createDiscoverTool } from "./tool_discovery";
import type { ToolDefinition } from "./types";

test("discover returns aliases and example calls", async () => {
  const tool = createDiscoverTool([
    {
      path: "calc.math.add_numbers",
      description: "Add numbers",
      approval: "auto",
      source: "openapi:calc",
      metadata: {
        argsType: "{ a: number; b: number }",
        returnsType: "{ sum: number }",
      },
      run: async () => ({ sum: 0 }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "addnumbers", depth: 2 },
    { taskId: "t", workspaceId: "w", isToolAllowed: () => true },
  ) as {
    results: Array<{
      path: string;
      aliases: string[];
      exampleCall: string;
      signature: string;
    }>;
    total: number;
  };

  expect(result.total).toBe(1);
  expect(result.results[0]?.path).toBe("calc.math.add_numbers");
  expect(result.results[0]?.aliases).toContain("calc.math.addNumbers");
  expect(result.results[0]?.aliases).toContain("calc.math.addnumbers");
  expect(result.results[0]?.exampleCall).toBe("await tools.calc.math.add_numbers({ a: ..., b: ... });");
  expect(result.results[0]?.signature).toContain("Promise<{ sum: number }>");
});

test("discover example call handles input-shaped args", async () => {
  const tool = createDiscoverTool([
    {
      path: "linear.mutation.issuecreate",
      description: "Create issue",
      approval: "required",
      source: "graphql:linear",
      metadata: {
        argsType: "{ input: { teamId: string; title: string } }",
        returnsType: "{ data: { id: string }; errors: unknown[] }",
      },
      run: async () => ({ data: { id: "x" }, errors: [] }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "issuecreate", depth: 2 },
    { taskId: "t", workspaceId: "w", isToolAllowed: () => true },
  ) as {
    results: Array<{ exampleCall: string }>;
  };

  expect(result.results[0]?.exampleCall).toBe(
    "await tools.linear.mutation.issuecreate({ input: { /* ... */ } });",
  );
});
