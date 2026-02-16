import { expect, test } from "bun:test";
import type { Id } from "../../database/convex/_generated/dataModel.d.ts";
import { createCatalogTools, createDiscoverTool } from "./tool-discovery";
import type { ToolDefinition } from "./types";

const TEST_WORKSPACE_ID = "w" as Id<"workspaces">;

test("discover returns aliases and example calls", async () => {
  const tool = createDiscoverTool([
    {
      path: "calc.math.add_numbers",
      description: "Add numbers",
      approval: "auto",
      source: "openapi:calc",
      typing: {
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
        outputSchema: {
          type: "object",
          properties: {
            sum: { type: "number" },
          },
          required: ["sum"],
        },
        requiredInputKeys: ["a", "b"],
        previewInputKeys: ["a", "b"],
      },
      run: async () => ({ sum: 0 }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "addnumbers", depth: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    bestPath: string | null;
    results: Array<{
      path: string;
      aliases: string[];
      exampleCall: string;
      signature: string;
      canonicalSignature: string;
      signatureInfo: {
        requiredKeys: string[];
        previewKeys: string[];
      };
    }>;
    total: number;
  };

  expect(result.bestPath).toBe("calc.math.add_numbers");
  expect(result.total).toBe(1);
  expect(result.results[0]?.path).toBe("calc.math.add_numbers");
  expect(result.results[0]?.aliases).toContain("calc.math.addNumbers");
  expect(result.results[0]?.aliases).toContain("calc.math.addnumbers");
  expect(result.results[0]?.exampleCall).toBe("await tools.calc.math.add_numbers({ a: ..., b: ... });");
  expect(result.results[0]?.signature).toContain("Promise<");
  expect(result.results[0]?.signature).toContain("sum");
  expect(result.results[0]?.canonicalSignature).toContain("sum");
  expect(result.results[0]?.signatureInfo.requiredKeys).toEqual(["a", "b"]);
});

test("discover example call handles input-shaped args", async () => {
  const tool = createDiscoverTool([
    {
      path: "linear.mutation.issuecreate",
      description: "Create issue",
      approval: "required",
      source: "graphql:linear",
      typing: {
        inputSchema: {
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                teamId: { type: "string" },
                title: { type: "string" },
              },
              required: ["teamId", "title"],
            },
          },
          required: ["input"],
        },
        requiredInputKeys: ["input"],
        previewInputKeys: ["input"],
      },
      run: async () => ({ data: { id: "x" }, errors: [] }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "issuecreate", depth: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
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
      typing: {
        inputSchema: {
          type: "object",
          properties: {
            filter: {},
            before: { type: "string" },
            after: { type: "string" },
            first: { type: "number" },
            last: { type: "number" },
            includeArchived: { type: "boolean" },
            orderBy: {},
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            data: {},
            errors: { type: "array", items: {} },
          },
          required: ["data"],
        },
        previewInputKeys: ["filter", "before", "after", "first", "last"],
      },
      run: async () => ({ data: {}, errors: [] }),
    } satisfies ToolDefinition,
  ]);

  const compactResult = await tool.run(
    { query: "linear teams", depth: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    bestPath: string | null;
    results: Array<{
      description: string;
      signature: string;
      canonicalSignature: string;
      signatureInfo: { previewKeys: string[] };
    }>;
  };

  const fullResult = await tool.run(
    { query: "linear teams", depth: 2, compact: false },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    bestPath: string | null;
    results: Array<{
      description: string;
      signature: string;
      canonicalSignature: string;
      signatureInfo: { previewKeys: string[] };
    }>;
  };

  expect(compactResult.bestPath).toBe("linear.query.teams");
  expect(fullResult.bestPath).toBe("linear.query.teams");
  expect(compactResult.results[0]?.signature).toContain("Promise<");
  expect(compactResult.results[0]?.signature).toContain("errors");
  expect(compactResult.results[0]?.signatureInfo.previewKeys).toContain("filter");
  expect(compactResult.results[0]?.description).not.toContain("TRAILING_MARKER_TEXT");

  expect(fullResult.results[0]?.signature).toContain("Promise<");
  expect(fullResult.results[0]?.description).toContain("TRAILING_MARKER_TEXT");
});

test("discover returns null bestPath when there are no matches", async () => {
  const tool = createDiscoverTool([
    {
      path: "calc.math.add_numbers",
      description: "Add numbers",
      approval: "auto",
      source: "openapi:calc",
      typing: {
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
      },
      run: async () => ({ sum: 0 }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "totally_unrelated_keyword" },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
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
      typing: {
        inputSchema: {
          type: "object",
          properties: { input: { type: "object", properties: { issueId: { type: "string" }, releaseId: { type: "string" } }, required: ["issueId", "releaseId"] } },
          required: ["input"],
        },
        requiredInputKeys: ["input"],
        previewInputKeys: ["input"],
      },
      run: async () => ({ data: {}, errors: [] }),
    } satisfies ToolDefinition,
    {
      path: "linear.mutation.issuecreate",
      description: "Create issue",
      approval: "required",
      source: "graphql:linear",
      typing: {
        inputSchema: {
          type: "object",
          properties: { input: { type: "object", properties: { teamId: { type: "string" }, title: { type: "string" } }, required: ["teamId", "title"] } },
          required: ["input"],
        },
        requiredInputKeys: ["input"],
        previewInputKeys: ["input"],
      },
      run: async () => ({ data: {}, errors: [] }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "linear issue create", depth: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
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
      typing: {
        inputSchema: { type: "object", properties: { org: { type: "string" } }, required: ["org"] },
        requiredInputKeys: ["org"],
        previewInputKeys: ["org"],
      },
      run: async () => ([]),
    } satisfies ToolDefinition,
    {
      path: "linear.query.teams",
      description: "List teams in Linear",
      approval: "auto",
      source: "graphql:linear",
      typing: {
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { data: {}, errors: { type: "array", items: {} } }, required: ["data"] },
      },
      run: async () => ({ data: {}, errors: [] }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "linear teams list", depth: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as { bestPath: string | null; results: Array<{ path: string }> };

  expect(result.bestPath).toBe("linear.query.teams");
  expect(result.results.some((entry) => entry.path.startsWith("github."))).toBe(false);
});

test("discover prefers simplified alias path for ugly namespaces", async () => {
  const tool = createDiscoverTool([
    {
      path: "vercel_vercel_api.domains.get_domain",
      description: "Get Vercel domain",
      approval: "auto",
      source: "openapi:vercel",
      typing: {
        inputSchema: { type: "object", properties: { domain: { type: "string" }, teamId: { type: "string" } }, required: ["domain"] },
        outputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
        requiredInputKeys: ["domain"],
        previewInputKeys: ["domain", "teamId"],
      },
      run: async () => ({ domain: "executor.sh" }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "vercel domain", depth: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    bestPath: string | null;
    results: Array<{ path: string; aliases: string[]; exampleCall: string }>;
  };

  expect(result.bestPath).toBe("vercel.domains.get_domain");
  expect(result.results[0]?.path).toBe("vercel.domains.get_domain");
  expect(result.results[0]?.aliases).toContain("vercel.domains.get_domain");
  expect(result.results[0]?.exampleCall).toContain("tools.vercel.domains.get_domain");
});

test("catalog tools list namespaces and typed signatures", async () => {
  const [namespacesTool, toolsTool] = createCatalogTools([
    {
      path: "vercel_vercel_api.domains.get_domain",
      description: "Get domain",
      approval: "auto",
      source: "openapi:vercel",
      typing: {
        inputSchema: { type: "object", properties: { domain: { type: "string" }, teamId: { type: "string" } }, required: ["domain"] },
        outputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
        requiredInputKeys: ["domain"],
        previewInputKeys: ["domain", "teamId"],
      },
      run: async () => ({ domain: "executor.sh" }),
    } satisfies ToolDefinition,
    {
      path: "utils.get_time",
      description: "Get time",
      approval: "auto",
      source: "local",
      typing: {
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { iso: { type: "string" }, unix: { type: "number" } }, required: ["iso", "unix"] },
      },
      run: async () => ({ iso: "", unix: 0 }),
    } satisfies ToolDefinition,
  ]);

  const namespaces = await namespacesTool!.run(
    {},
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as { namespaces: Array<{ namespace: string; toolCount: number }>; total: number };

  expect(namespaces.total).toBeGreaterThanOrEqual(2);
  expect(namespaces.namespaces.some((item) => item.namespace === "vercel" && item.toolCount >= 1)).toBe(true);

  const listed = await toolsTool!.run(
    { namespace: "vercel", compact: false, depth: 2, limit: 10 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    results: Array<{ path: string; aliases: string[]; signatureText: string; signatureInfo: { input: string; output: string } }>;
    total: number;
  };

  expect(listed.total).toBe(1);
  expect(listed.results[0]?.path).toBe("vercel.domains.get_domain");
  expect(listed.results[0]?.aliases).toContain("vercel.domains.get_domain");
  expect(listed.results[0]?.signatureText).toContain("domain");
  expect(listed.results[0]?.signatureInfo.input).toContain("domain");
  expect(listed.results[0]?.signatureInfo.output).toContain("domain");
});
