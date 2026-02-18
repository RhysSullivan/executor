import { Result } from "better-result";
import type { SandboxExecutionRequest } from "../../../types";
import { getCloudflareWorkerLoaderConfig } from "../../runtime-catalog";
import { transpileForRuntime } from "../../transpile";

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
 * 4. Only explicit `return` values from the isolate are included in callback
 *    completion payloads.
 *
 * 5. The host Worker executes the run inline and returns the terminal result
 *    directly in the HTTP response.
 *
 * ## Callback authentication
 *
 * The host Worker authenticates tool-callback RPCs using
 * `EXECUTOR_INTERNAL_TOKEN`.
 */
export interface CloudflareDispatchResult {
  ok: true;
  status: "completed" | "failed" | "timed_out" | "denied";
  result?: unknown;
  error?: string;
  exitCode?: number;
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
  const waitTimeoutMs = Math.max(config.requestTimeoutMs, request.timeoutMs + 30_000);
  const timeout = setTimeout(() => controller.abort(), waitTimeoutMs);

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
      return mkError(`Cloudflare sandbox execution timed out after ${waitTimeoutMs}ms`);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return mkError(`Cloudflare sandbox dispatch failed: ${message}`);
  }

  // ── Handle non-success HTTP status ────────────────────────────────────
  if (response.value.status !== 200) {
    const text = await Result.tryPromise(() => response.value.text());
    const body = text.unwrapOr(response.value.statusText);
    return mkError(`Cloudflare sandbox execution returned ${response.value.status}: ${body}`);
  }

  // ── Parse terminal response JSON ──────────────────────────────────────
  const body = await Result.tryPromise(() =>
    response.value.json() as Promise<{
      status?: "completed" | "failed" | "timed_out" | "denied";
      result?: unknown;
      error?: string;
      exitCode?: number;
    }>,
  );

  if (body.isErr()) {
    return mkError("Cloudflare sandbox execution returned invalid JSON");
  }

  if (!body.value.status) {
    return mkError("Cloudflare sandbox execution response missing status");
  }

  const normalizedError = typeof body.value.error === "string"
    ? body.value.error.trim()
    : "";
  const error = normalizedError.length > 0
    ? normalizedError
    : body.value.status === "failed"
      ? "Cloudflare sandbox execution failed without an error message"
      : undefined;

  return {
    ok: true,
    status: body.value.status,
    result: body.value.result,
    error,
    exitCode: body.value.exitCode,
    durationMs: Date.now() - startedAt,
  };
}
