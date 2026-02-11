"use node";

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

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.requestTimeoutMs,
  );

  try {
    // Transpile TS → JS on the Convex side before sending to the CF isolate.
    // The dynamic isolate runs the code as plain JS (harness.js), so any
    // TypeScript syntax must be stripped first.
    const code = await transpileForRuntime(request.code);

    const response = await fetch(config.runUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.authToken}`,
      },
      body: JSON.stringify({
        taskId: request.taskId,
        code,
        timeoutMs: request.timeoutMs,
        // The host Worker needs these to call back to Convex for tool
        // invocations and output streaming.
        callback: {
          baseUrl: config.callbackBaseUrl,
          authToken: config.callbackAuthToken,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      return {
        status: "failed",
        stdout: "",
        stderr: text,
        error: `Cloudflare sandbox returned ${response.status}: ${text}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const result = (await response.json()) as {
      status?: string;
      stdout?: string;
      stderr?: string;
      error?: string;
      exitCode?: number;
    };

    const status = mapStatus(result.status);

    return {
      status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode,
      error: result.error,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof DOMException && error.name === "AbortError";

    if (isAbort) {
      return {
        status: "timed_out",
        stdout: "",
        stderr: "",
        error: `Cloudflare sandbox request timed out after ${config.requestTimeoutMs}ms`,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      status: "failed",
      stdout: "",
      stderr: "",
      error: `Cloudflare sandbox request failed: ${message}`,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
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
