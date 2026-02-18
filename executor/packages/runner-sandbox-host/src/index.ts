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
 * 5. `/v1/runs` waits for execution to finish and returns the terminal result
 *    directly to the caller.
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
import { encodeToolCallResultForTransport } from "../../core/src/tool-call-result-transport";
import GLOBALS_MODULE from "./isolate/globals.isolate.js";
import HARNESS_CODE from "./isolate/harness.isolate.js";
import { authorizeRunRequest } from "./auth";
import { callToolWithBridge, getBridgePropsFromContext } from "./bridge";
import { parseRunRequest } from "./request";
import { executeSandboxRun } from "./sandbox";
import type { Env, RunResult, ToolCallResult } from "./types";

const failedResult = (error: string): RunResult => ({
  status: "failed",
  error,
});

// ── Tool Bridge Entrypoint ───────────────────────────────────────────────────
//
// This class is exposed as a named entrypoint on the host Worker. A loopback
// service binding (via `ctx.exports.ToolBridge({props: ...})`) is passed into
// the dynamic isolate's `env`. When the isolate calls
// `env.TOOL_BRIDGE.callTool(...)`, the RPC call lands here.
//
// `this.ctx.props` carries the callback URL and auth token for the specific task.

export class ToolBridge extends WorkerEntrypoint<Env> {
  private get props() {
    return getBridgePropsFromContext(this.ctx);
  }

  /** Forward a tool call to the Convex callback RPC action. */
  async callTool(toolPath: string, input: unknown, callId?: string): Promise<string> {
    const result = await callToolWithBridge(this.props, toolPath, input, callId);
    return encodeToolCallResultForTransport(result as ToolCallResult);
  }
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

    const authError = authorizeRunRequest(request, env.AUTH_TOKEN);
    if (authError) {
      return authError;
    }

    const parsed = await parseRunRequest(request);
    if (parsed instanceof Response) {
      return parsed;
    }

    const runResult = await Result.tryPromise(() => executeSandboxRun(parsed, ctx, env, HARNESS_CODE, GLOBALS_MODULE));
    const finalResult = runResult.isOk()
      ? runResult.value
      : failedResult(
          `Sandbox host error: ${runResult.error.cause instanceof Error
            ? runResult.error.cause.message
            : String(runResult.error.cause)}`,
        );

    return Response.json(finalResult, { status: 200 });
  },
};
