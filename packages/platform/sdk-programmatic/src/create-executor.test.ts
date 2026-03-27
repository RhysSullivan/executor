import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import type { CodeExecutor } from "@executor/codemode-core";
import * as Effect from "effect/Effect";

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

  it("accepts a custom CodeExecutor as runtime", async () => {
    const executeCalls: string[] = [];

    const runCode = async (
      code: string,
      toolInvoker: any,
    ): Promise<{ result: unknown; error?: string; logs: string[] }> => {
      const logs: string[] = [];
      const mockConsole = {
        log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      };
      // Build a minimal tools proxy
      const tools = new Proxy({} as any, {
        get(_, ns: string) {
          return new Proxy({} as any, {
            get(_, method: string) {
              return (args: unknown) =>
                Effect.runPromise(
                  toolInvoker.invoke({ path: `${ns}.${method}`, args }),
                );
            },
          });
        },
      });
      const fn = new Function(
        "tools",
        "console",
        `"use strict"; return (async () => { ${code} })();`,
      );
      try {
        const result = await fn(tools, mockConsole);
        return { result, logs };
      } catch (err: any) {
        return { result: undefined, error: err.message, logs };
      }
    };

    const customRuntime: CodeExecutor = {
      execute(code, toolInvoker) {
        executeCalls.push(code);
        return Effect.tryPromise({
          try: () => runCode(code, toolInvoker),
          catch: (err) =>
            err instanceof Error ? err : new Error(String(err)),
        });
      },
    };

    const executor = await createExecutor({
      storage: "memory",
      onToolApproval: "allow-all",
      runtime: customRuntime,
      tools: {
        "echo.back": {
          execute: async ({ msg }: { msg: string }) => ({ echo: msg }),
        },
      },
    });

    try {
      const result = await executor.execute(
        `const r = await tools.echo.back({ msg: "hi" }); return r;`,
      );
      expect(result.result).toEqual({ echo: "hi" });
      expect(executeCalls.length).toBe(1);
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

  it("memory storage persists policies across calls", async () => {
    const executor = await createExecutor({
      storage: "memory",
      onToolApproval: "allow-all",
    });

    try {
      // Create a policy
      await executor.policies.create({
        resourcePattern: "source.*",
        effect: "allow",
        approvalMode: "auto",
      });

      // List should return the created policy
      const policies = await executor.policies.list();
      expect(policies.length).toBeGreaterThanOrEqual(1);
      expect(policies.some((p: any) => p.resourcePattern === "source.*")).toBe(
        true,
      );
    } finally {
      await executor.close();
    }
  });

  it("multiple execute() calls share the same runtime state", async () => {
    const callLog: string[] = [];
    const executor = await createExecutor({
      storage: "memory",
      onToolApproval: "allow-all",
      tools: {
        "log.append": {
          execute: async ({ msg }: { msg: string }) => {
            callLog.push(msg);
            return { count: callLog.length };
          },
        },
      },
    });

    try {
      const r1 = await executor.execute(
        `return await tools.log.append({ msg: "first" });`,
      );
      const r2 = await executor.execute(
        `return await tools.log.append({ msg: "second" });`,
      );
      expect(r1.result).toEqual({ count: 1 });
      expect(r2.result).toEqual({ count: 2 });
      expect(callLog).toEqual(["first", "second"]);
    } finally {
      await executor.close();
    }
  });
});
