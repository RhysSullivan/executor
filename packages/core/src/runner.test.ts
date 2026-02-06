import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { defineTool, type ToolTree, type ApprovalDecision } from "./tools.js";
import { createRunner } from "./runner.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mathTools() {
  return {
    math: {
      add: defineTool({
        description: "Add two numbers",
        approval: "auto",
        args: z.object({ a: z.number(), b: z.number() }),
        returns: z.number(),
        run: async (input) => input.a + input.b,
      }),
      multiply: defineTool({
        description: "Multiply two numbers",
        approval: "auto",
        args: z.object({ a: z.number(), b: z.number() }),
        returns: z.number(),
        run: async (input) => input.a * input.b,
      }),
    },
  } satisfies ToolTree;
}

function writeTools(sideEffects: string[]) {
  return {
    db: {
      insert: defineTool({
        description: "Insert a record",
        approval: "required",
        args: z.object({ table: z.string(), data: z.record(z.string(), z.unknown()) }),
        returns: z.object({ id: z.string() }),
        run: async (input) => {
          sideEffects.push(`insert:${input.table}`);
          return { id: "new_1" };
        },
        formatApproval: (input) => ({
          title: `Insert into ${input.table}`,
        }),
      }),
      delete: defineTool({
        description: "Delete a record",
        approval: "required",
        args: z.object({ table: z.string(), id: z.string() }),
        returns: z.object({ deleted: z.boolean() }),
        run: async (input) => {
          sideEffects.push(`delete:${input.table}:${input.id}`);
          return { deleted: true };
        },
        formatApproval: (input) => ({
          title: `Delete ${input.id} from ${input.table}`,
        }),
      }),
    },
  } satisfies ToolTree;
}

let callIdSeq = 0;
function testCallId() {
  return `test_${++callIdSeq}`;
}

function alwaysApprove() {
  return async (_req: unknown) => "approved" as ApprovalDecision;
}

function alwaysDeny() {
  return async (_req: unknown) => "denied" as ApprovalDecision;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runner — sandbox isolation", () => {
  test("blocks fetch", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run('return fetch("https://evil.com")');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not available in the sandbox");
  });

  test("blocks process", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run("return process.env");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not available in the sandbox");
  });

  test("blocks require", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run('return require("fs")');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not available in the sandbox");
  });

  test("blocks Bun", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run("return Bun.env");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not available in the sandbox");
  });

  test("blocks dynamic import", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run('return await import("node:fs")');
    expect(result.ok).toBe(false);
    // The error message varies but it should fail
    expect(result.error).toBeDefined();
  });

  test("constructor chain escape returns sandbox global (no host access)", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    // The escape returns the sandbox global. Accessing 'process' on it
    // triggers our blocker getter which throws — that's the correct behavior.
    // The key thing is: process.env.SECRET etc. are never reachable.
    const result = await runner.run(`
      const escaped = [].constructor.constructor("return this")();
      // escaped is the sandbox global — has no host APIs
      // Only our injected properties exist on it
      try {
        escaped.process;
        return "BAD: process was accessible";
      } catch (e) {
        return "GOOD: process blocked";
      }
    `);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("GOOD: process blocked");
  });

  test("tool function toString is hidden", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run("return tools.math.add.toString()");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("function() { [native code] }");
  });

  test("execution timeout", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      timeoutMs: 100,
      newCallId: testCallId,
    });

    const result = await runner.run("while(true) {}");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });
});

describe("runner — auto-approved read tools", () => {
  test("executes tool and returns result", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysDeny(), // should never be called
      newCallId: testCallId,
    });

    const result = await runner.run("return await tools.math.add({ a: 3, b: 4 })");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(7);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]!.decision).toBe("auto");
    expect(result.receipts[0]!.status).toBe("succeeded");
  });

  test("multiple tool calls collect receipts", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysDeny(),
      newCallId: testCallId,
    });

    const result = await runner.run(`
      const a = await tools.math.add({ a: 1, b: 2 });
      const b = await tools.math.multiply({ a: a, b: 3 });
      return b;
    `);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(9);
    expect(result.receipts).toHaveLength(2);
  });

  test("validates input with zod", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run(
      'return await tools.math.add({ a: "not a number", b: 2 })',
    );
    expect(result.ok).toBe(false);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]!.status).toBe("failed");
    expect(result.receipts[0]!.error).toContain("validation failed");
  });
});

describe("runner — approval flow", () => {
  test("approved write tool runs", async () => {
    const sideEffects: string[] = [];
    const runner = createRunner({
      tools: writeTools(sideEffects),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run(
      'return await tools.db.insert({ table: "users", data: { name: "Alice" } })',
    );
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ id: "new_1" });
    expect(sideEffects).toEqual(["insert:users"]);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]!.decision).toBe("approved");
    expect(result.receipts[0]!.status).toBe("succeeded");
  });

  test("denied write tool returns undefined and doesn't run", async () => {
    const sideEffects: string[] = [];
    const runner = createRunner({
      tools: writeTools(sideEffects),
      requestApproval: alwaysDeny(),
      newCallId: testCallId,
    });

    const result = await runner.run(
      'return await tools.db.insert({ table: "users", data: { name: "Alice" } })',
    );
    expect(result.ok).toBe(false);
    expect(sideEffects).toEqual([]); // run was never called
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]!.decision).toBe("denied");
    expect(result.receipts[0]!.status).toBe("denied");
  });

  test("continues after one denial", async () => {
    const sideEffects: string[] = [];
    let callCount = 0;
    const approveOddDenyEven = async () => {
      callCount++;
      return (callCount % 2 === 1 ? "approved" : "denied") as ApprovalDecision;
    };

    const runner = createRunner({
      tools: writeTools(sideEffects),
      requestApproval: approveOddDenyEven,
      newCallId: testCallId,
    });

    const result = await runner.run(`
      const r1 = await tools.db.insert({ table: "a", data: {} });
      const r2 = await tools.db.insert({ table: "b", data: {} });
      const r3 = await tools.db.insert({ table: "c", data: {} });
      return [r1, r2, r3];
    `);

    // r1 approved, r2 denied (undefined), r3 approved
    expect(result.ok).toBe(false); // had a denial
    expect(sideEffects).toEqual(["insert:a", "insert:c"]);
    expect(result.receipts).toHaveLength(3);
    expect(result.receipts[0]!.decision).toBe("approved");
    expect(result.receipts[1]!.decision).toBe("denied");
    expect(result.receipts[2]!.decision).toBe("approved");
  });

  test("approval request includes formatApproval data", async () => {
    const sideEffects: string[] = [];
    let capturedRequest: unknown;
    const runner = createRunner({
      tools: writeTools(sideEffects),
      requestApproval: async (req) => {
        capturedRequest = req;
        return "approved";
      },
      newCallId: testCallId,
    });

    await runner.run(
      'await tools.db.delete({ table: "users", id: "user_42" })',
    );

    expect(capturedRequest).toBeDefined();
    const req = capturedRequest as { preview: { title: string } };
    expect(req.preview.title).toBe("Delete user_42 from users");
  });

  test("approval request falls back to default preview when formatApproval is missing", async () => {
    let capturedRequest: unknown;
    const tools: ToolTree = {
      vercel: {
        projects: {
          deleteProject: defineTool({
            description: "Delete a project",
            approval: "required",
            args: z.object({ idOrName: z.string() }),
            returns: z.object({ ok: z.boolean() }),
            run: async () => ({ ok: true }),
          }),
        },
      },
    };

    const runner = createRunner({
      tools,
      requestApproval: async (req) => {
        capturedRequest = req;
        return "denied";
      },
      newCallId: testCallId,
    });

    await runner.run('await tools.vercel.projects.deleteProject({ idOrName: "prj_123" })');

    const req = capturedRequest as {
      preview: {
        title: string;
        details?: string;
        action?: string;
        resourceIds?: string[];
        isDestructive?: boolean;
      };
    };
    expect(req.preview.title).toBe("Delete via vercel.projects.deleteProject");
    expect(req.preview.details).toContain("Target: prj_123");
    expect(req.preview.action).toBe("delete");
    expect(req.preview.resourceIds).toEqual(["prj_123"]);
    expect(req.preview.isDestructive).toBe(true);
  });
});

describe("runner — error handling", () => {
  test("tool run error is caught and recorded", async () => {
    const tools: ToolTree = {
      broken: defineTool({
        description: "Always fails",
        approval: "auto",
        args: z.object({}),
        returns: z.void(),
        run: async () => {
          throw new Error("Something went wrong");
        },
      }),
    };

    const runner = createRunner({
      tools,
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run("await tools.broken({})");
    expect(result.ok).toBe(false);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]!.status).toBe("failed");
    expect(result.receipts[0]!.error).toBe("Something went wrong");
  });

  test("syntax error in code is caught", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run("const x = {{{");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("runtime error in code is caught", async () => {
    const runner = createRunner({
      tools: mathTools(),
      requestApproval: alwaysApprove(),
      newCallId: testCallId,
    });

    const result = await runner.run("null.toString()");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
