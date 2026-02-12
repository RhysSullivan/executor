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
 *    (passed as a loopback service binding via `ctx.exports`) which invokes
 *    Convex callback RPC functions to resolve them.
 *
 * 4. Console output is intentionally discarded. Only explicit `return` values
 *    are included in terminal run results.
 *
 * 5. `/v1/runs` returns an accepted dispatch response immediately. Terminal
 *    result status is reported back to Convex through callback RPC.
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

import { Result } from "better-result";
import { WorkerEntrypoint } from "cloudflare:workers";
import { api } from "@executor/convex/_generated/api";
import { ConvexClient, ConvexHttpClient } from "convex/browser";

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
    convexUrl: string;
    internalSecret: string;
  };
}

interface RunResult {
  status: "completed" | "failed" | "timed_out" | "denied";
  result?: unknown;
  error?: string;
  exitCode?: number;
}

interface RunDispatchResponse {
  accepted: true;
  dispatchId: string;
}

interface ToolCallResult {
  ok: true | false;
  value?: unknown;
  error?: string;
  kind?: "pending" | "denied" | "failed";
  approvalId?: string;
  retryAfterMs?: number;
}

interface BridgeProps {
  callbackConvexUrl: string;
  callbackInternalSecret: string;
  taskId: string;
}

const APPROVAL_SUBSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000;

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const failedResult = (error: string): RunResult => ({
  status: "failed",
  error,
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

  private createConvexClient(): ConvexHttpClient {
    return new ConvexHttpClient(this.props.callbackConvexUrl, {
      skipConvexDeploymentUrlCheck: true,
    });
  }

  private createRealtimeClient(): ConvexClient {
    return new ConvexClient(this.props.callbackConvexUrl, {
      skipConvexDeploymentUrlCheck: true,
    });
  }

  private async waitForApprovalUpdate(approvalId: string): Promise<void> {
    const client = this.createRealtimeClient();

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        client.close();
        reject(new Error(`Timed out waiting for approval update: ${approvalId}`));
      }, APPROVAL_SUBSCRIPTION_TIMEOUT_MS);

      const unsubscribe = client.onUpdate(
        (api as any).runtimeCallbacks.getApprovalStatus,
        {
          internalSecret: this.props.callbackInternalSecret,
          runId: this.props.taskId,
          approvalId,
        },
        (value: { status?: "pending" | "approved" | "denied" | "missing" } | null | undefined) => {
          const status = value?.status;
          if (!status || status === "pending") {
            return;
          }
          if (status === "missing") {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            client.close();
            reject(new Error(`Approval not found: ${approvalId}`));
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          client.close();
          resolve();
        },
      );
    });
  }

  /** Forward a tool call to the Convex callback RPC action. */
  async callTool(toolPath: string, input: unknown, callId?: string): Promise<ToolCallResult> {
    const { callbackInternalSecret, taskId } = this.props;
    const effectiveCallId = callId && callId.trim().length > 0
      ? callId
      : `call_${crypto.randomUUID()}`;

    while (true) {
      const response = await Result.tryPromise(async () => {
        const convex = this.createConvexClient();
        return await convex.action(api.runtimeCallbacks.handleToolCall, {
          internalSecret: callbackInternalSecret,
          runId: taskId,
          callId: effectiveCallId,
          toolPath,
          input,
        });
      });

      if (response.isErr()) {
        const cause = response.error.cause;
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, kind: "failed", error: `Tool callback failed: ${message}` };
      }

      const result = response.value as ToolCallResult;
      if (!result.ok && result.kind === "pending") {
        if (!result.approvalId) {
          return { ok: false, kind: "failed", error: "Approval pending without approvalId" };
        }

        const approvalId = result.approvalId;
        const wait = await Result.tryPromise(() => this.waitForApprovalUpdate(approvalId));
        if (wait.isErr()) {
          const cause = wait.error.cause;
          const message = cause instanceof Error ? cause.message : String(cause);
          return { ok: false, kind: "failed", error: `Approval subscription failed: ${message}` };
        }
        continue;
      }

      return result;
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

async function executeSandboxRun(request: RunRequest, ctx: ExecutionContext, env: Env): Promise<RunResult> {
  const timeoutMs = request.timeoutMs ?? 300_000;
  const isolateId = request.taskId;

  const ctxExports = (ctx as unknown as {
    exports: Record<string, (opts: { props: BridgeProps }) => unknown>;
  }).exports;

  const toolBridgeBinding = ctxExports.ToolBridge({
    props: {
      callbackConvexUrl: request.callback.convexUrl,
      callbackInternalSecret: request.callback.internalSecret,
      taskId: request.taskId,
    },
  });

  const worker = env.LOADER.get(isolateId, async () => ({
    compatibilityDate: "2025-06-01",
    mainModule: "harness.js",
    modules: {
      "harness.js": HARNESS_CODE,
      "globals.js": GLOBALS_MODULE,
      "user-code.js": buildUserModule(request.code),
    },
    env: {
      TOOL_BRIDGE: toolBridgeBinding,
    },
    globalOutbound: null,
  }));

  const entrypoint = worker.getEntrypoint();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const response = await Result.tryPromise(() =>
    entrypoint.fetch("http://sandbox.internal/run", {
      method: "POST",
      signal: controller.signal,
    }),
  );

  clearTimeout(timer);

  if (response.isErr()) {
    const cause = response.error.cause;
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return {
        status: "timed_out",
        error: `Execution timed out after ${timeoutMs}ms`,
      };
    }
    throw cause;
  }

  const body = await Result.tryPromise(() => response.value.json() as Promise<RunResult>);
  if (body.isErr()) {
    return failedResult("Sandbox isolate returned invalid JSON");
  }
  return body.value;
}

async function reportRunCompletion(request: RunRequest, result: RunResult, durationMs: number): Promise<void> {
  const convex = new ConvexHttpClient(request.callback.convexUrl, {
    skipConvexDeploymentUrlCheck: true,
  });
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await Result.tryPromise(async () => {
      return await convex.mutation(api.runtimeCallbacks.completeRun, {
        internalSecret: request.callback.internalSecret,
        runId: request.taskId,
        status: result.status,
        result: result.result,
        exitCode: result.exitCode,
        error: result.error,
        durationMs,
      });
    });

    if (response.isOk()) {
      return;
    }

    lastError = response.error.cause;
    if (attempt < 3) {
      await sleep(200 * attempt);
    }
  }

  console.error("Failed to report run completion", {
    taskId: request.taskId,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
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
    const parsed = await Result.tryPromise(() => request.json() as Promise<RunRequest>);
    if (parsed.isErr()) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const body = parsed.value;

    if (!body.taskId || !body.code || !body.callback?.convexUrl || !body.callback?.internalSecret) {
      return Response.json(
        { error: "Missing required fields: taskId, code, callback.convexUrl, callback.internalSecret" },
        { status: 400 },
      );
    }

    const startedAt = Date.now();
    const dispatchId = `dispatch_${body.taskId}_${startedAt}`;

    ctx.waitUntil((async () => {
      const runResult = await Result.tryPromise(() => executeSandboxRun(body, ctx, env));
      const finalResult = runResult.isOk()
        ? runResult.value
        : failedResult(
            `Sandbox host error: ${runResult.error.cause instanceof Error
              ? runResult.error.cause.message
              : String(runResult.error.cause)}`,
          );

      await reportRunCompletion(body, finalResult, Date.now() - startedAt);
    })());

    const response: RunDispatchResponse = {
      accepted: true,
      dispatchId,
    };

    return Response.json(response, { status: 202 });
  },
};
