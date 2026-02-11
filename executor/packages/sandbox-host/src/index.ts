/**
 * Executor Sandbox Host Worker
 *
 * This Cloudflare Worker uses the Dynamic Worker Loader API to run
 * agent-generated code in sandboxed isolates. It exposes a single HTTP
 * endpoint (`POST /v1/runs`) that the executor's Convex action calls.
 *
 * ## How it works
 *
 * 1. Receives a run request with `{ taskId, code, timeoutMs, callback }`.
 *
 * 2. Uses `env.LOADER.get(id, () => WorkerCode)` to spawn a dynamic isolate
 *    containing the user's code.
 *
 * 3. The isolate's network access is fully blocked (`globalOutbound: null`).
 *    Instead, tool calls are routed through a `ToolBridge` entrypoint class
 *    (passed as a loopback service binding via `ctx.exports`) which calls back
 *    to the Convex HTTP API to resolve them.
 *
 * 4. Console output is buffered in the harness and returned in the response.
 *    Output lines are also streamed back to Convex in real-time via the
 *    ToolBridge binding.
 *
 * 5. The result (status, stdout, stderr, error) is returned as JSON.
 *
 * ## Code isolation
 *
 * User code is placed in a **separate JS module** (`user-code.js`) that
 * exports a single `run(tools, console)` async function. The harness module
 * (`harness.js`) imports and calls this function, passing controlled `tools`
 * and `console` proxies. Because the user code is in a different module, it
 * cannot access the harness's `fetch` handler scope, `req`, `env`, `ctx`,
 * or `Response` — preventing IIFE escape attacks and response forgery.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

// Import isolate modules as raw text — these are loaded as JS modules inside
// the dynamic isolate, NOT executed in the host worker. The *.isolate.js
// extension is mapped to Text type in wrangler.jsonc rules, so wrangler
// bundles them as string constants instead of trying to execute them.
// @ts-expect-error — wrangler Text module import (no TS declarations)
import GLOBALS_MODULE from "./isolate/globals.isolate.js";
// @ts-expect-error — wrangler Text module import (no TS declarations)
import HARNESS_CODE from "./isolate/harness.isolate.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface Env {
  LOADER: WorkerLoader;
  AUTH_TOKEN: string;
}

/** Dynamic Worker Loader binding — provided by the `worker_loaders` config. */
interface WorkerLoader {
  get(id: string, getCode: () => Promise<WorkerCode>): WorkerStub;
}

interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string | { js: string } | { text: string } | { json: object }>;
  env?: Record<string, unknown>;
  globalOutbound?: unknown | null;
}

interface WorkerStub {
  getEntrypoint(name?: string, options?: { props?: unknown }): EntrypointStub;
}

interface EntrypointStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

interface RunRequest {
  taskId: string;
  code: string;
  timeoutMs: number;
  callback: {
    baseUrl: string;
    authToken: string;
  };
}

interface RunResult {
  status: "completed" | "failed" | "timed_out" | "denied";
  stdout: string;
  stderr: string;
  error?: string;
  exitCode?: number;
}

interface ToolCallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  denied?: boolean;
}

interface BridgeProps {
  callbackBaseUrl: string;
  callbackAuthToken: string;
  taskId: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/** Constant-time string comparison to prevent timing side-channels. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  if (bufA.length !== bufB.length) {
    // Compare against self to keep timing consistent, then return false.
    let result = 0;
    for (let i = 0; i < bufA.length; i++) {
      result |= (bufA[i] ?? 0) ^ (bufA[i] ?? 0);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return result === 0;
}

// ── Tool Bridge Entrypoint ───────────────────────────────────────────────────
//
// This class is exposed as a named entrypoint on the host Worker. A loopback
// service binding (via `ctx.exports.ToolBridge({props: ...})`) is passed into
// the dynamic isolate's `env`. When the isolate calls
// `env.TOOL_BRIDGE.callTool(...)`, the RPC call lands here.
//
// `this.ctx.props` carries the callback URL and auth token for the specific task.

export class ToolBridge extends WorkerEntrypoint<Env> {
  private get props(): BridgeProps {
    return (this.ctx as unknown as { props: BridgeProps }).props;
  }

  /** Forward a tool call to the Convex internal HTTP API. */
  async callTool(toolPath: string, input: unknown): Promise<ToolCallResult> {
    const { callbackBaseUrl, callbackAuthToken, taskId } = this.props;
    const url = `${callbackBaseUrl}/internal/runs/${taskId}/tool-call`;
    const callId = `call_${crypto.randomUUID()}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${callbackAuthToken}`,
      },
      body: JSON.stringify({ callId, toolPath, input }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return { ok: false, error: `Tool callback failed (${response.status}): ${text}` };
    }

    return (await response.json()) as ToolCallResult;
  }

  /** Stream a console output line back to Convex (best-effort). */
  async emitOutput(stream: "stdout" | "stderr", line: string): Promise<void> {
    const { callbackBaseUrl, callbackAuthToken, taskId } = this.props;
    const url = `${callbackBaseUrl}/internal/runs/${taskId}/output`;

    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${callbackAuthToken}`,
        },
        body: JSON.stringify({ stream, line, timestamp: Date.now() }),
      });
    } catch {
      // Swallow — output streaming is best-effort.
    }
  }
}

// ── Sandbox Harness ──────────────────────────────────────────────────────────
//
// The harness is a static ES module loaded as the main module of the dynamic
// isolate. User code lives in a **separate** module (`user-code.js`) and is
// imported by the harness. This prevents user code from accessing or
// manipulating the harness's fetch handler, `req`, `env`, `ctx`, or `Response`.
//
// Both HARNESS_CODE and GLOBALS_MODULE are imported as raw text from
// `./isolate/harness.js` and `./isolate/globals.js` respectively, so they
// can be authored as real JS files with proper syntax highlighting and linting.

/**
 * Build the user code module. The code is wrapped in an exported async
 * function `run(tools, console)` so the harness can call it with controlled
 * scope bindings. The user code runs in a separate module from the harness
 * and cannot access `req`, `env`, `ctx`, or `Response`.
 */
function buildUserModule(userCode: string): string {
  return `export async function run(tools, console) {\n"use strict";\n${userCode}\n}\n`;
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method !== "POST" || url.pathname !== "/v1/runs") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // ── Auth ──────────────────────────────────────────────────────────────
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const token = authHeader.slice("Bearer ".length);
    if (!timingSafeEqual(token, env.AUTH_TOKEN)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ── Parse body ────────────────────────────────────────────────────────
    let body: RunRequest;
    try {
      body = (await request.json()) as RunRequest;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.taskId || !body.code || !body.callback?.baseUrl || !body.callback?.authToken) {
      return Response.json(
        { error: "Missing required fields: taskId, code, callback.baseUrl, callback.authToken" },
        { status: 400 },
      );
    }

    const timeoutMs = body.timeoutMs ?? 300_000;
    const isolateId = body.taskId;

    try {
      const ctxExports = (ctx as unknown as {
        exports: Record<string, (opts: { props: BridgeProps }) => unknown>;
      }).exports;

      const toolBridgeBinding = ctxExports.ToolBridge({
        props: {
          callbackBaseUrl: body.callback.baseUrl,
          callbackAuthToken: body.callback.authToken,
          taskId: body.taskId,
        },
      });

      const worker = env.LOADER.get(isolateId, async () => ({
        compatibilityDate: "2025-06-01",
        mainModule: "harness.js",
        modules: {
          "harness.js": HARNESS_CODE,
          // Globals captured before user code is evaluated.
          "globals.js": GLOBALS_MODULE,
          // User code is in a separate module — it exports run(tools, console)
          // and cannot access the harness's fetch handler scope.
          "user-code.js": buildUserModule(body.code),
        },
        env: {
          TOOL_BRIDGE: toolBridgeBinding,
        },
        globalOutbound: null,
      }));

      const entrypoint = worker.getEntrypoint();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await entrypoint.fetch("http://sandbox.internal/run", {
          method: "POST",
          signal: controller.signal,
        });
        const result = (await response.json()) as RunResult;
        return Response.json(result);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return Response.json({
            status: "timed_out",
            stdout: "",
            stderr: "",
            error: `Execution timed out after ${timeoutMs}ms`,
          } satisfies RunResult);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({
        status: "failed",
        stdout: "",
        stderr: "",
        error: `Sandbox host error: ${message}`,
      } satisfies RunResult);
    }
  },
};
