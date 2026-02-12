import { test, expect, describe } from "bun:test";
import { generateToolDeclarations, generateToolInventory, typecheckCode, type TypecheckResult } from "./typechecker";
import { prepareOpenApiSpec, buildOpenApiToolsFromPrepared } from "./tool_sources";
import type { ToolDescriptor } from "./types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MATH_TOOL: ToolDescriptor = {
  path: "math.add",
  description: "Add two numbers",
  approval: "auto",
  argsType: "{ a: number; b: number }",
  returnsType: "{ result: number }",
};

const ADMIN_TOOL: ToolDescriptor = {
  path: "admin.send_announcement",
  description: "Send an announcement",
  approval: "required",
  argsType: "{ message: string; channel?: string }",
  returnsType: "{ sent: boolean }",
};

const FLAT_TOOL: ToolDescriptor = {
  path: "get_time",
  description: "Get current time",
  approval: "auto",
  argsType: "{}",
  returnsType: "{ iso: string; unix: number }",
};

const ALL_TOOLS = [MATH_TOOL, ADMIN_TOOL, FLAT_TOOL];

// ---------------------------------------------------------------------------
// generateToolDeclarations
// ---------------------------------------------------------------------------

describe("generateToolDeclarations", () => {
  test("empty tools produces empty tools object", () => {
    const result = generateToolDeclarations([]);
    expect(result).toBe("declare const tools: {\n\n};");
  });

  test("flat tool (no dots in path beyond single segment)", () => {
    const result = generateToolDeclarations([FLAT_TOOL]);
    expect(result).toContain("get_time(input?: {}): Promise<{ iso: string; unix: number }>;");
  });

  test("nested tool (math.add)", () => {
    const result = generateToolDeclarations([MATH_TOOL]);
    expect(result).toContain("math: {");
    expect(result).toContain("add(input: { a: number; b: number }): Promise<{ result: number }>;");
  });

  test("multiple tools produce correct nesting", () => {
    const result = generateToolDeclarations(ALL_TOOLS);
    // math namespace
    expect(result).toContain("math: {");
    expect(result).toContain("add(input: { a: number; b: number }): Promise<{ result: number }>;");
    // admin namespace
    expect(result).toContain("admin: {");
    expect(result).toContain("send_announcement(input: { message: string; channel?: string }): Promise<{ sent: boolean }>;");
    // flat
    expect(result).toContain("get_time(input?: {}): Promise<{ iso: string; unix: number }>;");
  });

  test("missing argsType defaults to Record<string, unknown>", () => {
    const tool: ToolDescriptor = {
      path: "foo.bar",
      description: "test",
      approval: "auto",
    };
    const result = generateToolDeclarations([tool]);
    expect(result).toContain("bar(input?: Record<string, unknown>): Promise<unknown>;");
  });

  test("missing returnsType defaults to unknown", () => {
    const tool: ToolDescriptor = {
      path: "baz",
      description: "test",
      approval: "auto",
      argsType: "{ x: number }",
    };
    const result = generateToolDeclarations([tool]);
    expect(result).toContain("baz(input: { x: number }): Promise<unknown>;");
  });

  test("uses OpenAPI operations indexed-access types when source d.ts is provided", () => {
    const tools: ToolDescriptor[] = [
      {
        path: "github.issues.list_for_repo",
        description: "List issues for a repo",
        approval: "auto",
        source: "openapi:github",
        operationId: "issues/list-for-repo",
        argsType: "{ owner: string; repo: string }",
        returnsType: "unknown",
      },
    ];

    const sourceDts = `
export interface operations {
  "issues/list-for-repo": {
    parameters: { path: { owner: string; repo: string } };
    responses: { 200: { content: { "application/json": { ok: true }[] } } };
  };
}
`;

    const result = generateToolDeclarations(tools, {
      sourceDtsBySource: {
        "openapi:github": sourceDts,
      },
    });

    expect(result).toContain("type ToolInput<Op>");
    expect(result).toContain("interface operations");
    expect(result).toContain(
      "list_for_repo(input: ToolInput<operations[\"issues/list-for-repo\"]>): Promise<ToolOutput<operations[\"issues/list-for-repo\"]>>;",
    );
  });
});

// ---------------------------------------------------------------------------
// generateToolInventory
// ---------------------------------------------------------------------------

describe("generateToolInventory", () => {
  test("empty tools returns empty string", () => {
    expect(generateToolInventory([])).toBe("");
  });

  test("includes namespace summary and discover guidance", () => {
    const result = generateToolInventory(ALL_TOOLS);
    expect(result).toContain("You have access to these tool namespaces:");
    expect(result).toContain("admin (1)");
    expect(result).toContain("math (1)");
    expect(result).toContain("Use `tools.discover({ query, depth?, limit?, compact? })` first");
    expect(result).toContain("Never shadow the global `tools` object");
  });

  test("includes example callable paths", () => {
    const result = generateToolInventory(ALL_TOOLS);
    expect(result).toContain("Example callable paths:");
    expect(result).toContain("tools.math.add(...)");
    expect(result).toContain("tools.admin.send_announcement(...)");
  });
});

// ---------------------------------------------------------------------------
// typecheckCode
// ---------------------------------------------------------------------------

describe("typecheckCode", () => {
  const declarations = generateToolDeclarations(ALL_TOOLS);

  test("valid code passes", () => {
    const result = typecheckCode("return 40 + 2;", declarations);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("valid tool call passes", () => {
    const result = typecheckCode(
      'const sum = await tools.math.add({ a: 1, b: 2 }); return sum.result;',
      declarations,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("valid async code with await", () => {
    const result = typecheckCode(
      `const time = await tools.get_time({});
       console.log(time.iso);
       return time.unix;`,
      declarations,
    );
    expect(result.ok).toBe(true);
  });

  test("console.log is available", () => {
    const result = typecheckCode('console.log("hello"); return 1;', declarations);
    expect(result.ok).toBe(true);
  });

  test("setTimeout is available", () => {
    const result = typecheckCode(
      'const id = setTimeout(() => {}, 100); clearTimeout(id); return 1;',
      declarations,
    );
    expect(result.ok).toBe(true);
  });

  test("wrong argument types produce errors", () => {
    const result = typecheckCode(
      'const sum = await tools.math.add({ a: "not a number", b: 2 });',
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("string") || e.includes("number"))).toBe(true);
  });

  test("missing required argument produces errors", () => {
    const result = typecheckCode(
      "const sum = await tools.math.add({ a: 1 });",
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("b"))).toBe(true);
  });

  test("non-existent tool produces errors", () => {
    const result = typecheckCode(
      "const result = await tools.nonexistent.doStuff({});",
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  test("accessing wrong property on result produces errors", () => {
    const result = typecheckCode(
      "const sum = await tools.math.add({ a: 1, b: 2 }); return sum.nonexistent;",
      declarations,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  test("type errors have adjusted line numbers", () => {
    const code = `const x = 1;
const y = "hello";
const z: number = y;`;
    const result = typecheckCode(code, declarations);
    expect(result.ok).toBe(false);
    // The error should reference line 3 of the user code, not the wrapper
    expect(result.errors.some((e) => e.startsWith("Line 3:"))).toBe(true);
  });

  test("empty declarations (no tools) still works for plain code", () => {
    const emptyDecl = generateToolDeclarations([]);
    const result = typecheckCode("return 42;", emptyDecl);
    expect(result.ok).toBe(true);
  });

  test("complex valid code with multiple tool calls", () => {
    const code = `
const sum = await tools.math.add({ a: 10, b: 20 });
const announcement = await tools.admin.send_announcement({ message: "Sum is " + sum.result });
const time = await tools.get_time({});
console.log(time.iso);
return { sum: sum.result, sent: announcement.sent, time: time.unix };
`;
    const result = typecheckCode(code, declarations);
    expect(result.ok).toBe(true);
  });

  test("optional parameter can be omitted", () => {
    const result = typecheckCode(
      'const r = await tools.admin.send_announcement({ message: "hi" }); return r.sent;',
      declarations,
    );
    expect(result.ok).toBe(true);
  });

  test("OpenAPI indexed-access declarations typecheck like Monaco", () => {
    const tools: ToolDescriptor[] = [
      {
        path: "github.issues.list_for_repo",
        description: "List issues for a repo",
        approval: "auto",
        source: "openapi:github",
        operationId: "issues/list-for-repo",
      },
    ];

    const sourceDts = `
export interface operations {
  "issues/list-for-repo": {
    parameters: { path: { owner: string; repo: string }; query: { state?: "open" | "closed" } };
    responses: { 200: { content: { "application/json": { id: number; title: string }[] } } };
  };
}
`;

    const declarations = generateToolDeclarations(tools, {
      sourceDtsBySource: {
        "openapi:github": sourceDts,
      },
    });

    const ok = typecheckCode(
      'const rows = await tools.github.issues.list_for_repo({ owner: "answeroverflow", repo: "answeroverflow", state: "open" }); return rows[0]?.id;',
      declarations,
    );
    expect(ok.ok).toBe(true);

    const bad = typecheckCode(
      'await tools.github.issues.list_for_repo({ owner: 123, repo: "answeroverflow" });',
      declarations,
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  test("OpenAPI helper types infer vendor JSON response payloads", () => {
    const tools: ToolDescriptor[] = [
      {
        path: "github.activity.get_feeds",
        description: "Get feeds",
        approval: "auto",
        source: "openapi:github",
        operationId: "activity/get-feeds",
      },
    ];

    const sourceDts = `
export interface operations {
  "activity/get-feeds": {
    parameters: { query?: never; path?: never; header?: never; cookie?: never };
    responses: {
      200: { content: { "application/vnd.github+json": { current_user_url: string; timeline_url: string } } };
    };
  };
}
`;

    const declarations = generateToolDeclarations(tools, {
      sourceDtsBySource: {
        "openapi:github": sourceDts,
      },
    });

    const ok = typecheckCode(
      "const feed = await tools.github.activity.get_feeds({}); return feed.current_user_url;",
      declarations,
    );
    expect(ok.ok).toBe(true);

    const bad = typecheckCode(
      "const feed = await tools.github.activity.get_feeds({}); return feed.missing_field;",
      declarations,
    );
    expect(bad.ok).toBe(false);
  });

  test("optional parameter can be provided", () => {
    const result = typecheckCode(
      'const r = await tools.admin.send_announcement({ message: "hi", channel: "general" }); return r.sent;',
      declarations,
    );
    expect(result.ok).toBe(true);
  });

  test("discover remains callable when OpenAPI fallback args contain hyphenated header names", async () => {
    const spec: Record<string, unknown> = {
      openapi: "3.0.3",
      info: { title: "Header names", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/meta": {
          get: {
            operationId: "meta/get",
            tags: ["meta"],
            parameters: [
              {
                name: "X-GitHub-Api-Version",
                in: "header",
                required: false,
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        ok: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const prepared = await prepareOpenApiSpec(spec, "headers");
    const built = buildOpenApiToolsFromPrepared(
      {
        type: "openapi",
        name: "github",
        spec,
        baseUrl: "https://api.example.com",
      },
      prepared,
    );

    const descriptors: ToolDescriptor[] = built.map((tool) => ({
      path: tool.path,
      description: tool.description,
      approval: tool.approval,
      source: tool.source,
      argsType: tool.metadata?.argsType,
      returnsType: tool.metadata?.returnsType,
      operationId: tool.metadata?.operationId,
    }));
    descriptors.push({
      path: "discover",
      description: "Discover tools",
      approval: "auto",
      source: "system",
      argsType: "{ query: string; depth?: number; limit?: number; compact?: boolean }",
      returnsType: "unknown",
    });

    const declarations = generateToolDeclarations(descriptors);
    const result = typecheckCode(
      'const found = await tools.discover({ query: "github issues" }); return found;',
      declarations,
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("invalid type hint strings are downgraded instead of corrupting declarations", () => {
    const tools: ToolDescriptor[] = [
      {
        path: "github.meta.get",
        description: "Get metadata",
        approval: "auto",
        // Intentionally invalid TS type expression (unquoted hyphenated key)
        argsType: "{ X-GitHub-Api-Version?: string }",
        returnsType: "unknown",
      },
      {
        path: "discover",
        description: "Discover tools",
        approval: "auto",
        argsType: "{ query: string; depth?: number; limit?: number; compact?: boolean }",
        returnsType: "unknown",
      },
    ];

    const declarations = generateToolDeclarations(tools);
    expect(declarations).toContain("get(input: Record<string, unknown>): Promise<unknown>;");

    const result = typecheckCode(
      'const found = await tools.discover({ query: "github" }); return found;',
      declarations,
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

