import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { runCodeWithCloudflareWorkerLoader } from "./cloudflare_worker_loader_runtime";

// ── Fake host worker ─────────────────────────────────────────────────────────
//
// This test spins up a local HTTP server that mimics the CF host worker's
// /v1/runs endpoint. It validates the request shape and returns a result.
// It also acts as the callback server for /internal/runs/:id/tool-call.

let fakeHostServer: ReturnType<typeof Bun.serve>;
let fakeCallbackServer: ReturnType<typeof Bun.serve>;

const AUTH_TOKEN = "test-sandbox-token";
const CALLBACK_TOKEN = "test-callback-token";

const toolResponses = new Map<string, unknown>();
const capturedOutputs: Array<{ stream: string; line: string }> = [];

beforeAll(() => {
  // Callback server — mimics the Convex /internal/runs/:id/tool-call endpoint
  fakeCallbackServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      // Verify auth
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${CALLBACK_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      // Tool call
      if (url.pathname.endsWith("/tool-call")) {
        const body = (await req.json()) as { toolPath: string; input: unknown };
        const response = toolResponses.get(body.toolPath);
        if (response !== undefined) {
          return Response.json({ ok: true, value: response });
        }
        return Response.json({ ok: false, error: `Unknown tool: ${body.toolPath}` });
      }

      // Output
      if (url.pathname.endsWith("/output")) {
        const body = (await req.json()) as { stream: string; line: string };
        capturedOutputs.push({ stream: body.stream, line: body.line });
        return Response.json({ ok: true });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  // Host server — mimics the CF sandbox host worker's /v1/runs endpoint
  fakeHostServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      if (url.pathname !== "/v1/runs" || req.method !== "POST") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${AUTH_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const body = (await req.json()) as {
        taskId: string;
        code: string;
        timeoutMs: number;
        callback: { baseUrl: string; authToken: string };
      };

      // Simulate the sandbox running the code in a very simplified way.
      // In production, the CF Worker Loader would spawn an isolate.
      // Here we just use eval-like logic to test the protocol.
      const stdout: string[] = [];
      const stderr: string[] = [];

      try {
        // Simulate console and tools
        const consoleProxy = {
          log: (...args: unknown[]) => stdout.push(args.map(String).join(" ")),
          info: (...args: unknown[]) => stdout.push(args.map(String).join(" ")),
          warn: (...args: unknown[]) => stderr.push(args.map(String).join(" ")),
          error: (...args: unknown[]) => stderr.push(args.map(String).join(" ")),
        };

        // For tool calls, call back to the callback server
        const callTool = async (toolPath: string, input: unknown) => {
          const callbackUrl = `${body.callback.baseUrl}/internal/runs/${body.taskId}/tool-call`;
          const resp = await fetch(callbackUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${body.callback.authToken}`,
            },
            body: JSON.stringify({ callId: `call_${crypto.randomUUID()}`, toolPath, input }),
          });
          const result = (await resp.json()) as { ok: boolean; value?: unknown; error?: string };
          if (!result.ok) throw new Error(result.error ?? "Tool call failed");
          return result.value;
        };

        // Emit output back to callback server
        const emitLine = async (stream: string, line: string) => {
          const outputUrl = `${body.callback.baseUrl}/internal/runs/${body.taskId}/output`;
          await fetch(outputUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${body.callback.authToken}`,
            },
            body: JSON.stringify({ stream, line, timestamp: Date.now() }),
          }).catch(() => {});
        };

        // Create a minimal tools proxy
        const createProxy = (path: string[] = []): unknown => {
          const callable = () => {};
          return new Proxy(callable, {
            get(_target, prop) {
              if (prop === "then") return undefined;
              if (typeof prop !== "string") return undefined;
              return createProxy([...path, prop]);
            },
            async apply(_target, _thisArg, args) {
              return callTool(path.join("."), args[0]);
            },
          });
        };

        const tools = createProxy();
        const fn = new Function(
          "tools", "console", "setTimeout", "clearTimeout",
          `"use strict"; return (async () => {\n${body.code}\n})();`,
        );
        const value = await fn(tools, consoleProxy, setTimeout, clearTimeout);

        if (value !== undefined) {
          stdout.push(`result: ${JSON.stringify(value)}`);
        }

        // Stream output to callback
        for (const line of stdout) await emitLine("stdout", line);
        for (const line of stderr) await emitLine("stderr", line);

        return Response.json({
          status: "completed",
          stdout: stdout.join("\n"),
          stderr: stderr.join("\n"),
          exitCode: 0,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({
          status: "failed",
          stdout: stdout.join("\n"),
          stderr: stderr.join("\n"),
          error: message,
        });
      }
    },
  });

  // Set environment variables for the runtime
  process.env.CLOUDFLARE_SANDBOX_RUN_URL = `http://127.0.0.1:${fakeHostServer.port}/v1/runs`;
  process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN = AUTH_TOKEN;
  process.env.CONVEX_SITE_URL = `http://127.0.0.1:${fakeCallbackServer.port}`;
  process.env.EXECUTOR_INTERNAL_TOKEN = CALLBACK_TOKEN;
  process.env.CLOUDFLARE_SANDBOX_REQUEST_TIMEOUT_MS = "10000";
});

afterAll(() => {
  fakeHostServer?.stop(true);
  fakeCallbackServer?.stop(true);
  delete process.env.CLOUDFLARE_SANDBOX_RUN_URL;
  delete process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN;
  delete process.env.CONVEX_SITE_URL;
  delete process.env.EXECUTOR_INTERNAL_TOKEN;
  delete process.env.CLOUDFLARE_SANDBOX_REQUEST_TIMEOUT_MS;
});

describe("cloudflare worker loader runtime", () => {
  test("executes simple code and returns stdout", async () => {
    const result = await runCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `console.log("hello from cf sandbox");`,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("hello from cf sandbox");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test("returns a value", async () => {
    const result = await runCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `return 42;`,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("42");
  });

  test("captures errors as failed status", async () => {
    const result = await runCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `throw new Error("boom");`,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("boom");
  });

  test("calls tools via callback server", async () => {
    toolResponses.set("math.add", { sum: 7 });

    const result = await runCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `
        const out = await tools.math.add({ a: 3, b: 4 });
        console.log("sum:", out.sum);
      `,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("sum: 7");

    toolResponses.delete("math.add");
  });

  test("streams output to callback server", async () => {
    capturedOutputs.length = 0;

    const result = await runCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `console.log("streamed line");`,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(capturedOutputs.some((o) => o.line === "streamed line" && o.stream === "stdout")).toBe(
      true,
    );
  });

  test("transpiles TypeScript code before sending to sandbox", async () => {
    const result = await runCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `
        interface User {
          name: string;
          age: number;
        }
        const user: User = { name: "Alice", age: 30 };
        const greet = (u: User): string => \`Hello \${u.name}, age \${u.age}\`;
        console.log(greet(user));
      `,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("Hello Alice, age 30");
  });

  test("reports TypeScript syntax errors clearly", async () => {
    const result = await runCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      // Unterminated type syntax that TS transpiler will reject
      code: `const x: = 5;`,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("TypeScript transpile error");
  });

  test("handles unknown tool gracefully", async () => {
    const result = await runCodeWithCloudflareWorkerLoader({
      taskId: `task_${crypto.randomUUID()}`,
      code: `await tools.nonexistent.thing({});`,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("nonexistent.thing");
  });
});

describe("runtime catalog", () => {
  test("isKnownRuntimeId recognizes both runtimes", async () => {
    const {
      isKnownRuntimeId,
      LOCAL_BUN_RUNTIME_ID,
      CLOUDFLARE_WORKER_LOADER_RUNTIME_ID,
    } = await import("./runtime_catalog");

    expect(isKnownRuntimeId(LOCAL_BUN_RUNTIME_ID)).toBe(true);
    expect(isKnownRuntimeId(CLOUDFLARE_WORKER_LOADER_RUNTIME_ID)).toBe(true);
    expect(isKnownRuntimeId("unknown-runtime")).toBe(false);
  });

  test("isCloudflareWorkerLoaderConfigured checks env vars", async () => {
    const { isCloudflareWorkerLoaderConfigured } = await import("./runtime_catalog");
    // Env vars are set in beforeAll
    expect(isCloudflareWorkerLoaderConfigured()).toBe(true);
  });

  test("getCloudflareWorkerLoaderConfig reads env vars", async () => {
    const { getCloudflareWorkerLoaderConfig } = await import("./runtime_catalog");
    const config = getCloudflareWorkerLoaderConfig();

    expect(config.runUrl).toContain("/v1/runs");
    expect(config.authToken).toBe(AUTH_TOKEN);
    expect(config.callbackBaseUrl).toContain(String(fakeCallbackServer.port));
    expect(config.callbackAuthToken).toBe(CALLBACK_TOKEN);
    expect(config.requestTimeoutMs).toBe(10_000);
  });
});
