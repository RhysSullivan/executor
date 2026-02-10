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
    bestPath: string | null;
    results: Array<{
      path: string;
      aliases: string[];
      exampleCall: string;
      signature: string;
    }>;
    total: number;
  };

  expect(result.bestPath).toBe("calc.math.add_numbers");
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
    bestPath: string | null;
    results: Array<{ exampleCall: string }>;
  };

  expect(result.bestPath).toBe("linear.mutation.issuecreate");
  expect(result.results[0]?.exampleCall).toBe(
    "await tools.linear.mutation.issuecreate({ input: { /* ... */ } });",
  );
});

test("discover uses compact signatures by default and allows full mode", async () => {
  const tool = createDiscoverTool([
    {
      path: "linear.query.teams",
      description: "All teams whose issues can be accessed by the user. Compact output should trim this long explanation before it reaches the trailing marker text to keep discover results concise for models. TRAILING_MARKER_TEXT",
      approval: "auto",
      source: "graphql:linear",
      metadata: {
        argsType: "{ filter?: TeamFilter; before?: string; after?: string; first?: number; last?: number; includeArchived?: boolean; orderBy?: PaginationOrderBy }",
        returnsType: "{ data: TeamConnection; errors: unknown[] }",
      },
      run: async () => ({ data: {}, errors: [] }),
    } satisfies ToolDefinition,
  ]);

  const compactResult = await tool.run(
    { query: "linear teams", depth: 2 },
    { taskId: "t", workspaceId: "w", isToolAllowed: () => true },
  ) as {
    bestPath: string | null;
    results: Array<{ description: string; signature: string }>;
  };

  const fullResult = await tool.run(
    { query: "linear teams", depth: 2, compact: false },
    { taskId: "t", workspaceId: "w", isToolAllowed: () => true },
  ) as {
    bestPath: string | null;
    results: Array<{ description: string; signature: string }>;
  };

  expect(compactResult.bestPath).toBe("linear.query.teams");
  expect(fullResult.bestPath).toBe("linear.query.teams");
  expect(compactResult.results[0]?.signature).toContain("filter: ...");
  expect(compactResult.results[0]?.signature).toContain("Promise<{ data: ...; errors: unknown[] }>");
  expect(compactResult.results[0]?.description).not.toContain("TRAILING_MARKER_TEXT");

  expect(fullResult.results[0]?.signature).toContain("TeamFilter");
  expect(fullResult.results[0]?.signature).toContain("TeamConnection");
  expect(fullResult.results[0]?.description).toContain("TRAILING_MARKER_TEXT");
});

test("discover returns null bestPath when there are no matches", async () => {
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
    { query: "totally_unrelated_keyword" },
    { taskId: "t", workspaceId: "w", isToolAllowed: () => true },
  ) as { bestPath: string | null; results: Array<unknown>; total: number };

  expect(result.bestPath).toBeNull();
  expect(result.total).toBe(0);
  expect(result.results).toHaveLength(0);
});

test("discover bestPath prefers simpler exact intent operation", async () => {
  const tool = createDiscoverTool([
    {
      path: "linear.mutation.issuetoreleasecreate",
      description: "Create issue-to-release join",
      approval: "required",
      source: "graphql:linear",
      metadata: {
        argsType: "{ input: { issueId: string; releaseId: string } }",
        returnsType: "{ data: IssueToReleasePayload; errors: unknown[] }",
      },
      run: async () => ({ data: {}, errors: [] }),
    } satisfies ToolDefinition,
    {
      path: "linear.mutation.issuecreate",
      description: "Create issue",
      approval: "required",
      source: "graphql:linear",
      metadata: {
        argsType: "{ input: { teamId: string; title: string } }",
        returnsType: "{ data: IssuePayload; errors: unknown[] }",
      },
      run: async () => ({ data: {}, errors: [] }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "linear issue create", depth: 2 },
    { taskId: "t", workspaceId: "w", isToolAllowed: () => true },
  ) as { bestPath: string | null; results: Array<{ path: string }> };

  expect(result.bestPath).toBe("linear.mutation.issuecreate");
  expect(result.results[0]?.path).toBe("linear.mutation.issuecreate");
});

test("discover namespace hint suppresses cross-namespace bestPath", async () => {
  const tool = createDiscoverTool([
    {
      path: "github.teams.list",
      description: "List teams",
      approval: "auto",
      source: "openapi:github",
      metadata: {
        argsType: "{ org: string }",
        returnsType: "Array<Team>",
      },
      run: async () => ([]),
    } satisfies ToolDefinition,
    {
      path: "linear.query.teams",
      description: "List teams in Linear",
      approval: "auto",
      source: "graphql:linear",
      metadata: {
        argsType: "{}",
        returnsType: "{ data: TeamConnection; errors: unknown[] }",
      },
      run: async () => ({ data: {}, errors: [] }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "linear teams list", depth: 2 },
    { taskId: "t", workspaceId: "w", isToolAllowed: () => true },
  ) as { bestPath: string | null; results: Array<{ path: string }> };

  expect(result.bestPath).toBe("linear.query.teams");
  expect(result.results.some((entry) => entry.path.startsWith("github."))).toBe(false);
});
