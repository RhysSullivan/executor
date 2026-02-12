"use node";

import { Result } from "better-result";
import type { SandboxExecutionRequest } from "../types";
import { getCloudflareWorkerLoaderConfig } from "./runtime_catalog";
import { transpileForRuntime } from "./transpile";

/**
 * Run agent-generated code via a Cloudflare Worker that uses the Dynamic
 * Worker Loader API to spawn a sandboxed isolate.
 *
 * ## Architecture
 *
 * 1. This function (running inside a Convex action) POSTs the code + config to
 *    a **host Worker** deployed on Cloudflare.
 *
 * 2. The host Worker uses `env.LOADER.get(id, callback)` to create a dynamic
 *    isolate containing the user code.
 *
 * 3. The dynamic isolate's `tools` proxy calls are intercepted by a
 *    `ToolBridge` entrypoint in the host Worker (passed via `env` bindings),
 *    which in turn calls Convex callback RPCs to resolve tools.
 *
 * 4. Console output from the isolate is similarly relayed back via callback
 *    RPC mutation.
 *
 * 5. The host Worker accepts the run immediately and finishes execution
 *    asynchronously, reporting terminal results back through callback RPC.
 *
 * ## Callback authentication
 *
 * The host Worker authenticates callback RPCs using `EXECUTOR_INTERNAL_TOKEN`.
 */
export interface CloudflareDispatchResult {
  ok: true;
  accepted: true;
  dispatchId: string;
  durationMs: number;
}

export interface CloudflareDispatchError {
  ok: false;
  error: string;
  durationMs: number;
}

export async function dispatchCodeWithCloudflareWorkerLoader(
  request: SandboxExecutionRequest,
): Promise<CloudflareDispatchResult | CloudflareDispatchError> {
  const config = getCloudflareWorkerLoaderConfig();
  const startedAt = Date.now();

  const mkError = (error: string): CloudflareDispatchError => ({
    ok: false,
    error,
    durationMs: Date.now() - startedAt,
  });

  // ── Transpile TS → JS on the Convex side ─────────────────────────────
  const transpiled = transpileForRuntime(request.code);
  if (transpiled.isErr()) {
    return mkError(transpiled.error.message);
  }

  // ── POST to CF host worker ────────────────────────────────────────────
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  const response = await Result.tryPromise(() =>
    fetch(config.runUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.authToken}`,
      },
      body: JSON.stringify({
        taskId: request.taskId,
        code: transpiled.value,
        timeoutMs: request.timeoutMs,
        callback: {
          convexUrl: config.callbackConvexUrl,
          internalSecret: config.callbackInternalSecret,
        },
      }),
      signal: controller.signal,
    }),
  );

  clearTimeout(timeout);

  if (response.isErr()) {
    const cause = response.error.cause;
    const isAbort = cause instanceof DOMException && cause.name === "AbortError";
    if (isAbort) {
      return mkError(`Cloudflare sandbox dispatch timed out after ${config.requestTimeoutMs}ms`);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return mkError(`Cloudflare sandbox dispatch failed: ${message}`);
  }

  // ── Handle non-accepted HTTP status ───────────────────────────────────
  if (response.value.status !== 202) {
    const text = await Result.tryPromise(() => response.value.text());
    const body = text.unwrapOr(response.value.statusText);
    return mkError(`Cloudflare sandbox dispatch returned ${response.value.status}: ${body}`);
  }

  // ── Parse accepted response JSON ──────────────────────────────────────
  const body = await Result.tryPromise(() =>
    response.value.json() as Promise<{
      accepted?: boolean;
      dispatchId?: string;
    }>,
  );

  if (body.isErr()) {
    return mkError("Cloudflare sandbox dispatch returned invalid JSON");
  }

  if (!body.value.accepted || !body.value.dispatchId) {
    return mkError("Cloudflare sandbox dispatch response missing accepted/dispatchId");
  }

  return {
    ok: true,
    accepted: true,
    dispatchId: body.value.dispatchId,
    durationMs: Date.now() - startedAt,
  };
}
