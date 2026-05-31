import { Layer } from "effect";

import {
  makeConsoleMcpErrorReporter,
  makeMcpBuildServer,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import type { McpErrorReporter } from "@executor-js/host-mcp";
import {
  inMemoryMcpSessionsLayer,
  makeInMemoryMcpSessionStore,
  type InMemoryMcpSessionStore,
} from "@executor-js/host-mcp/in-memory-session-store";

import type { CloudflareConfig } from "../config";
import { makeCloudflareExecutionStackLayer } from "../execution";
import { ErrorCaptureLive } from "../observability";

// ---------------------------------------------------------------------------
// Cloudflare McpSessionStore wiring — the SAME shared seam as self-host. The
// store body, the per-session engine builder (`makeMcpBuildServer`), and the
// console error reporter (`makeConsoleMcpErrorReporter`) all live in shared
// code; the Cloudflare host supplies only its fully-provided execution-stack
// layer (QuickJS over the long-lived D1 handle). The cross-isolate variant is
// cloud's Durable Object store behind this same `McpSessionStore` seam.
// ---------------------------------------------------------------------------

/** Build the in-process MCP session store over the long-lived D1 handle. */
export const makeCloudflareMcpSessionStore = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
): InMemoryMcpSessionStore =>
  makeInMemoryMcpSessionStore(
    makeMcpBuildServer(makeCloudflareExecutionStackLayer(config, dbHandle)),
  );

/** The `McpSessionStore` envelope seam over a freshly built in-process store. */
export const cloudflareMcpSessions = inMemoryMcpSessionsLayer;

/** Route 500-defects through the host's console `ErrorCapture`. */
export const cloudflareMcpReporter: Layer.Layer<McpErrorReporter> =
  makeConsoleMcpErrorReporter(ErrorCaptureLive);
