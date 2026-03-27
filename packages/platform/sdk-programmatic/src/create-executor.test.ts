import {
  describe,
  expect,
  it,
} from "@effect/vitest";

import { createExecutor } from "./create-executor";
import type { ExecutorSDK } from "./types";

describe("createExecutor", () => {
  it("creates executor with memory storage and allow-all defaults", async () => {
    const executor = await createExecutor({
      storage: "memory",
      onToolApproval: "allow-all",
    });

    expect(executor).toBeDefined();
    expect(typeof executor.execute).toBe("function");
    expect(typeof executor.close).toBe("function");
    expect(typeof executor.sources.list).toBe("function");
    expect(typeof executor.policies.list).toBe("function");
    expect(typeof executor.secrets.list).toBe("function");

    await executor.close();
  });

  it("creates executor with default options (all defaults)", async () => {
    const executor = await createExecutor();

    expect(executor).toBeDefined();
    await executor.close();
  });

  it("execute() runs code and returns result", async () => {
    const executor = await createExecutor({
      storage: "memory",
      onToolApproval: "allow-all",
    });

    try {
      const result = await executor.execute("return 42;");
      expect(result.result).toBe(42);
      expect(result.error).toBeUndefined();
    } finally {
      await executor.close();
    }
  });

  it("execute() captures logs", async () => {
    const executor = await createExecutor({
      storage: "memory",
      onToolApproval: "allow-all",
    });

    try {
      const result = await executor.execute(
        'console.log("hello"); return "done";',
      );
      expect(result.result).toBe("done");
      expect(result.logs?.some((l) => l.includes("hello"))).toBe(true);
    } finally {
      await executor.close();
    }
  });

  it("execute() returns error for failing code", async () => {
    const executor = await createExecutor({
      storage: "memory",
      onToolApproval: "allow-all",
    });

    try {
      const result = await executor.execute("throw new Error('boom');");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("boom");
    } finally {
      await executor.close();
    }
  });

  it("execute() can call inline tools", async () => {
    const executor = await createExecutor({
      storage: "memory",
      onToolApproval: "allow-all",
      tools: {
        "math.add": {
          description: "Add two numbers",
          execute: async ({ a, b }: { a: number; b: number }) => ({
            sum: a + b,
          }),
        },
        "text.upper": {
          description: "Uppercase a string",
          execute: async ({ text }: { text: string }) => text.toUpperCase(),
        },
      },
    });

    try {
      const result = await executor.execute(
        `const r = await tools.math.add({ a: 10, b: 32 }); return r;`,
      );
      expect(result.result).toEqual({ sum: 42 });
      expect(result.error).toBeUndefined();
    } finally {
      await executor.close();
    }
  });

  it("execute() chains multiple inline tool calls", async () => {
    const calls: string[] = [];
    const executor = await createExecutor({
      storage: "memory",
      onToolApproval: "allow-all",
      tools: {
        "step.one": {
          execute: async () => {
            calls.push("one");
            return { value: 1 };
          },
        },
        "step.two": {
          execute: async ({ prev }: { prev: number }) => {
            calls.push("two");
            return { value: prev + 1 };
          },
        },
      },
    });

    try {
      const result = await executor.execute(`
        const a = await tools.step.one({});
        const b = await tools.step.two({ prev: a.value });
        return b;
      `);
      expect(result.result).toEqual({ value: 2 });
      expect(calls).toEqual(["one", "two"]);
    } finally {
      await executor.close();
    }
  });

  it("sources.list() returns empty array on fresh executor", async () => {
    const executor = await createExecutor({
      storage: "memory",
      onToolApproval: "allow-all",
    });

    try {
      const sources = await executor.sources.list();
      expect(Array.isArray(sources)).toBe(true);
    } finally {
      await executor.close();
    }
  });
});
