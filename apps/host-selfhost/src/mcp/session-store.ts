import { Effect, Layer } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ErrorCapture } from "@executor-js/api";
import { McpErrorReporter, type Principal } from "@executor-js/host-mcp";
import {
  inMemoryMcpSessionsLayer,
  makeInMemoryMcpSessionStore,
  McpEngineBuildError,
  type InMemoryMcpSessionStore,
} from "@executor-js/host-mcp/in-memory-session-store";
import { createExecutorMcpServer } from "@executor-js/host-mcp/tool-server";

import { ErrorCaptureLive } from "../observability";
import { SelfHostDb, type SelfHostDbHandle } from "../db/self-host-db";
import { makeExecutionStack, SelfHostExecutionStackLayer } from "../execution";

// ---------------------------------------------------------------------------
// Self-host McpSessionStore wiring — the shared in-process store
// (`@executor-js/host-mcp/in-memory-session-store`) over self-host's engine.
//
// The store body (the transports/servers/owners Maps, dispatch, ownership,
// lifetime) is provider-neutral and lives in host-mcp; self-host supplies only
// the per-session `buildServer` (its QuickJS engine over the shared SelfHostDb)
// and the error-reporter override. Cloud's DO store and the Cloudflare host use
// the same `McpSessionStore` seam — different backends behind one envelope.
// ---------------------------------------------------------------------------

export { McpEngineBuildError } from "@executor-js/host-mcp/in-memory-session-store";

/**
 * The store's internal engine boundary: build the per-(user,org) scoped executor
 * over the long-lived `SelfHostDb` (QuickJS code substrate) and hand the engine
 * to `createExecutorMcpServer`. Engine construction reads the long-lived DB, so
 * this closes over the handle captured at boot — no per-request layer plumbing.
 */
const makeBuildServer =
  (db: SelfHostDbHandle) =>
  (principal: Principal): Effect.Effect<McpServer, McpEngineBuildError> =>
    makeExecutionStack(
      principal.accountId,
      principal.organizationId,
      principal.organizationName,
    ).pipe(
      Effect.map(({ engine }) => engine),
      Effect.provide(SelfHostExecutionStackLayer),
      Effect.provideService(SelfHostDb, db),
      Effect.mapError((cause) => new McpEngineBuildError({ cause })),
      Effect.flatMap((engine) => createExecutorMcpServer({ engine })),
    );

/**
 * Build the in-process session store (plus its `close()` lifetime hook) over the
 * long-lived `SelfHostDb` handle, using self-host's per-session engine builder.
 */
export const makeSelfHostMcpSessionStore = (db: SelfHostDbHandle): InMemoryMcpSessionStore =>
  makeInMemoryMcpSessionStore(makeBuildServer(db));

/** The `McpSessionStore` envelope seam over a freshly built in-process store. */
export const selfHostMcpSessions = inMemoryMcpSessionsLayer;

// ---------------------------------------------------------------------------
// Self-host McpErrorReporter seam — reuses the shared `ErrorCapture` service so
// a request-orchestration defect the shared MCP envelope is about to render as a
// JSON-RPC 500 still flows through the host's normal capture pipeline (self-host:
// the console `ErrorCaptureLive`). Without this seam override the envelope
// swallows the cause into a `Response` and the operator never sees it.
// ---------------------------------------------------------------------------

export const selfHostMcpReporter: Layer.Layer<McpErrorReporter> = Layer.effect(
  McpErrorReporter,
  Effect.gen(function* () {
    const capture = yield* ErrorCapture;
    return {
      report: (cause) => Effect.asVoid(capture.captureException(cause)),
    };
  }),
).pipe(Layer.provide(ErrorCaptureLive));
