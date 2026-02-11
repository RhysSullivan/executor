"use node";

import { Result } from "better-result";
import type { SandboxExecutionRequest, SandboxExecutionResult } from "../types";
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
 *    which in turn calls back to the Convex `/internal/runs/{runId}/tool-call`
 *    HTTP endpoint to resolve the tool.
 *
 * 4. Console output from the isolate is similarly relayed back to
 *    `/internal/runs/{runId}/output`.
 *
 * 5. When execution completes, the host Worker returns the result as JSON and
 *    this function maps it to a `SandboxExecutionResult`.
 *
 * ## Callback authentication
 *
 * The host Worker authenticates its callbacks using the same
 * `EXECUTOR_INTERNAL_TOKEN` bearer token that the Convex HTTP API expects.
 */
export async function runCodeWithCloudflareWorkerLoader(
  request: SandboxExecutionRequest,
): Promise<SandboxExecutionResult> {
  const config = getCloudflareWorkerLoaderConfig();
  const startedAt = Date.now();

  const mkResult = (
    status: SandboxExecutionResult["status"],
    opts?: { stdout?: string; stderr?: string; error?: string; exitCode?: number },
  ): SandboxExecutionResult => ({
    status,
    stdout: opts?.stdout ?? "",
    stderr: opts?.stderr ?? "",
    exitCode: opts?.exitCode,
    error: opts?.error,
    durationMs: Date.now() - startedAt,
  });

  // ── Transpile TS → JS on the Convex side ─────────────────────────────
  const transpiled = transpileForRuntime(request.code);
  if (transpiled.isErr()) {
    return mkResult("failed", { error: transpiled.error.message });
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
          baseUrl: config.callbackBaseUrl,
          authToken: config.callbackAuthToken,
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
      return mkResult("timed_out", {
        error: `Cloudflare sandbox request timed out after ${config.requestTimeoutMs}ms`,
      });
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return mkResult("failed", {
      error: `Cloudflare sandbox request failed: ${message}`,
    });
  }

  // ── Handle non-OK HTTP status ─────────────────────────────────────────
  if (!response.value.ok) {
    const text = await Result.tryPromise(() => response.value.text());
    const body = text.unwrapOr(response.value.statusText);
    return mkResult("failed", {
      stderr: body,
      error: `Cloudflare sandbox returned ${response.value.status}: ${body}`,
    });
  }

  // ── Parse JSON response ───────────────────────────────────────────────
  const body = await Result.tryPromise(() =>
    response.value.json() as Promise<{
      status?: string;
      stdout?: string;
      stderr?: string;
      error?: string;
      exitCode?: number;
    }>,
  );

  if (body.isErr()) {
    return mkResult("failed", {
      error: `Cloudflare sandbox returned invalid JSON`,
    });
  }

  return mkResult(mapStatus(body.value.status), {
    stdout: body.value.stdout,
    stderr: body.value.stderr,
    exitCode: body.value.exitCode,
    error: body.value.error,
  });
}

function mapStatus(
  raw: string | undefined,
): SandboxExecutionResult["status"] {
  switch (raw) {
    case "completed":
      return "completed";
    case "timed_out":
      return "timed_out";
    case "denied":
      return "denied";
    default:
      return "failed";
  }
}
