import { Effect, Layer } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ErrorCapture } from "@executor-js/api";
import { type ExecutorDbHandle } from "@executor-js/api/server";
import { McpErrorReporter, type Principal } from "@executor-js/host-mcp";
import {
  inMemoryMcpSessionsLayer,
  makeInMemoryMcpSessionStore,
  McpEngineBuildError,
  type InMemoryMcpSessionStore,
} from "@executor-js/host-mcp/in-memory-session-store";
import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";

import type { CloudflareConfig } from "../config";
import { makeCloudflareExecutionStackLayer, makeExecutionStack } from "../execution";
import { ErrorCaptureLive } from "../observability";

// ---------------------------------------------------------------------------
// Cloudflare McpSessionStore wiring — the shared in-process store
// (`@executor-js/host-mcp/in-memory-session-store`) over the QuickJS engine.
//
// Identical seam to self-host: the provider-neutral store body lives in
// host-mcp; the Cloudflare host supplies only the per-session `buildServer` (the
// QuickJS engine over the long-lived D1 handle) and the error reporter. The
// in-process store fits the single-Worker QuickJS model — one isolate owns the
// session. The cross-isolate variant is cloud's Durable Object store behind this
// same `McpSessionStore` seam; that's the v2 upgrade once sessions must survive
// isolate eviction (a DO bound to `env.MCP_SESSION`).
// ---------------------------------------------------------------------------

/**
 * Build the per-session `McpServer` for a principal: assemble the scoped QuickJS
 * engine over the long-lived D1 handle (the shared `makeExecutionStack` reading
 * the Cloudflare execution-stack seams) and hand it to `createExecutorMcpServer`.
 */
const makeBuildServer =
  (config: CloudflareConfig, dbHandle: ExecutorDbHandle) =>
  (principal: Principal): Effect.Effect<McpServer, McpEngineBuildError> =>
    makeExecutionStack(
      principal.accountId,
      principal.organizationId,
      principal.organizationName,
    ).pipe(
      Effect.map(({ engine }) => engine),
      Effect.provide(makeCloudflareExecutionStackLayer(config, dbHandle)),
      Effect.mapError((cause) => new McpEngineBuildError({ cause })),
      Effect.flatMap((engine) => createExecutorMcpServer({ engine })),
    );

/** Build the in-process MCP session store over the long-lived D1 handle. */
export const makeCloudflareMcpSessionStore = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
): InMemoryMcpSessionStore => makeInMemoryMcpSessionStore(makeBuildServer(config, dbHandle));

/** The `McpSessionStore` envelope seam over a freshly built in-process store. */
export const cloudflareMcpSessions = inMemoryMcpSessionsLayer;

// ---------------------------------------------------------------------------
// Cloudflare McpErrorReporter seam — routes an orchestration defect the MCP
// envelope is about to render as a JSON-RPC 500 through the host's console
// `ErrorCapture`, so the operator still sees it (the envelope otherwise swallows
// the cause into a Response). Mirrors self-host's reporter.
// ---------------------------------------------------------------------------

export const cloudflareMcpReporter: Layer.Layer<McpErrorReporter> = Layer.effect(
  McpErrorReporter,
  Effect.gen(function* () {
    const capture = yield* ErrorCapture;
    return {
      report: (cause) => Effect.asVoid(capture.captureException(cause)),
    };
  }),
).pipe(Layer.provide(ErrorCaptureLive));
