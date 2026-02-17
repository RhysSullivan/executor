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

test("discover resolves ref hints from source-level tables", async () => {
  const tool = createDiscoverTool([
    {
      path: "crm.contacts.create",
      description: "Create contact",
      approval: "required",
      source: "openapi:crm",
      typing: {
        inputSchema: {
          type: "object",
          properties: {
            payload: { $ref: "#/components/schemas/CreateContactPayload" },
          },
          required: ["payload"],
        },
        outputSchema: {
          type: "object",
          properties: {
            contact: { $ref: "#/components/schemas/Contact" },
          },
          required: ["contact"],
        },
        refHintKeys: ["CreateContactPayload", "Contact"],
        typedRef: {
          kind: "openapi_operation",
          sourceKey: "openapi:crm",
          operationId: "createContact",
        },
      },
      run: async () => ({ contact: { id: "c_1", email: "a@b.com" } }),
    } satisfies ToolDefinition,
  ], {
    sourceRefHintTables: {
      "openapi:crm": {
        CreateContactPayload: "{ email: string; name?: string }",
        Contact: "{ id: string; email: string; name?: string }",
      },
    },
  });

  const result = await tool.run(
    { query: "create contact", depth: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    bestPath: string | null;
    refHintTable?: Record<string, string>;
    results: Array<{
      signatureInfo: {
        input: string;
        output: string;
      };
    }>;
  };

  expect(result.bestPath).toBe("crm.contacts.create");
  expect(result.results[0]?.signatureInfo.input).toContain("components[\"schemas\"][\"CreateContactPayload\"]");
  expect(result.results[0]?.signatureInfo.output).toContain("components[\"schemas\"][\"Contact\"]");
  expect(result.refHintTable).toEqual({
    CreateContactPayload: "{ email: string; name?: string }",
    Contact: "{ id: string; email: string; name?: string }",
  });
});

test("discover returns a shared top-level refHintTable for repeated refs", async () => {
  const tool = createDiscoverTool([
    {
      path: "crm.contacts.create",
      description: "Create contact",
      approval: "required",
      source: "openapi:crm",
      typing: {
        inputSchema: {
          type: "object",
          properties: { payload: { $ref: "#/components/schemas/SharedPayload" } },
        },
        refHintKeys: ["SharedPayload"],
        typedRef: {
          kind: "openapi_operation",
          sourceKey: "openapi:crm",
          operationId: "createContact",
        },
      },
      run: async () => ({ ok: true }),
    } satisfies ToolDefinition,
    {
      path: "crm.contacts.update",
      description: "Update contact",
      approval: "required",
      source: "openapi:crm",
      typing: {
        inputSchema: {
          type: "object",
          properties: { payload: { $ref: "#/components/schemas/SharedPayload" } },
        },
        refHintKeys: ["SharedPayload"],
        typedRef: {
          kind: "openapi_operation",
          sourceKey: "openapi:crm",
          operationId: "updateContact",
        },
      },
      run: async () => ({ ok: true }),
    } satisfies ToolDefinition,
  ], {
    sourceRefHintTables: {
      "openapi:crm": {
        SharedPayload: "{ email: string; name?: string }",
      },
    },
  });

  const result = await tool.run(
    { query: "contact", depth: 2, limit: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    refHintTable?: Record<string, string>;
    results: Array<{
      signatureInfo: {
        refHints?: Record<string, string>;
      };
    }>;
  };

  expect(result.refHintTable).toEqual({ SharedPayload: "{ email: string; name?: string }" });
  expect(result.results[0]?.signatureInfo.refHints).toBeUndefined();
  expect(result.results[1]?.signatureInfo.refHints).toBeUndefined();
});

test("discover returns full signatures and descriptions", async () => {
  const tool = createDiscoverTool([
    {
      path: "linear.query.teams",
      description: "All teams whose issues can be accessed by the user. This long explanation should stay intact, including the trailing marker text. TRAILING_MARKER_TEXT",
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

  const result = await tool.run(
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

  expect(result.bestPath).toBe("linear.query.teams");
  expect(result.results[0]?.signature).toContain("Promise<");
  expect(result.results[0]?.signature).toContain("errors");
  expect(result.results[0]?.signatureInfo.previewKeys).toContain("filter");
  expect(result.results[0]?.description).toContain("TRAILING_MARKER_TEXT");
});

test("discover compacts fallback intersection input hints", async () => {
  const tool = createDiscoverTool([
    {
      path: "certs.projects.add_certificates",
      description: "Add certificates to project",
      approval: "required",
      source: "openapi:certs",
      typing: {
        inputSchema: {
          allOf: [
            {
              type: "object",
              properties: {
                project_id: { type: "string" },
              },
              required: ["project_id"],
            },
            {
              type: "object",
              properties: {
                certificate_ids: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["certificate_ids"],
            },
          ],
        },
        outputSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
          required: ["ok"],
        },
      },
      run: async () => ({ ok: true }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "add certificates", depth: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    bestPath: string | null;
    results: Array<{
      signatureInfo: {
        input: string;
      };
    }>;
  };

  expect(result.bestPath).toBe("certs.projects.add_certificates");
  expect(result.results[0]?.signatureInfo.input).toBe("{ project_id: string; certificate_ids: string[] }");
});

test("discover compacts typed intersection input hints", async () => {
  const tool = createDiscoverTool([
    {
      path: "github.actions.add_custom_labels_to_self_hosted_runner_for_org",
      description: "Add labels to runner",
      approval: "required",
      source: "openapi:github",
      typing: {
        inputHint: `{
  org: string;
  runner_id: number
} & {
  labels: string[]
}`,
      },
      run: async () => ({ ok: true }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "add custom labels", depth: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    bestPath: string | null;
    results: Array<{
      signatureInfo: {
        input: string;
      };
    }>;
  };

  expect(result.bestPath).toBe("github.actions.add_custom_labels_to_self_hosted_runner_for_org");
  expect(result.results[0]?.signatureInfo.input).toBe("{ org: string; runner_id: number; labels: string[] }");
});

test("discover depth 0 keeps full signatures", async () => {
  const tool = createDiscoverTool([
    {
      path: "github.actions.add_custom_labels_to_self_hosted_runner_for_org",
      description: "Add labels to runner",
      approval: "required",
      source: "openapi:github",
      typing: {
        inputHint: "{ org: string; runner_id: number; labels: string[] }",
        outputHint: "{ total_count: number; labels: string[] }",
      },
      run: async () => ({ total_count: 1, labels: ["x64"] }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "add custom labels", depth: 0 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    results: Array<{
      signature: string;
    }>;
  };

  expect(result.results[0]?.signature).toBe(
    "(input: { org: string; runner_id: number; labels: string[] }): Promise<{ total_count: number; labels: string[] }>",
  );
});

test("discover prefers schema over lossy typed hints", async () => {
  const tool = createDiscoverTool([
    {
      path: "openai.batch.create_batch",
      description: "Create batch",
      approval: "required",
      source: "openapi:openai",
      typing: {
        inputHint: "{ input_file_id: ...; endpoint: ... }",
        outputHint: "{ id: string; errors?: { message?:... } }",
        inputSchema: {
          type: "object",
          properties: {
            input_file_id: { type: "string" },
            endpoint: { type: "string" },
            completion_window: { type: "string" },
          },
          required: ["input_file_id", "endpoint", "completion_window"],
        },
        outputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            errors: {
              type: "object",
              properties: {
                message: { type: "string" },
              },
            },
          },
          required: ["id"],
        },
      },
      run: async () => ({ id: "b_123" }),
    } satisfies ToolDefinition,
  ]);

  const result = await tool.run(
    { query: "create batch", depth: 2 },
    { taskId: "t", workspaceId: TEST_WORKSPACE_ID, isToolAllowed: () => true },
  ) as {
    results: Array<{
      signatureInfo: {
        input: string;
        output: string;
      };
    }>;
  };

  expect(result.results[0]?.signatureInfo.input).toContain("input_file_id: string");
  expect(result.results[0]?.signatureInfo.input.includes("...")).toBe(false);
  expect(result.results[0]?.signatureInfo.output).toContain("message?: string");
  expect(result.results[0]?.signatureInfo.output.includes("...")).toBe(false);
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
    { namespace: "vercel", depth: 2, limit: 10 },
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
