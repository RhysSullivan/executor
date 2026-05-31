import { Layer } from "effect";

import { makeConsoleMcpErrorReporter } from "@executor-js/api/server";
import type { McpErrorReporter, McpSessionStore } from "@executor-js/host-mcp";
import {
  makeDurableObjectMcpSessionStore,
  type McpSessionDOStub,
} from "@executor-js/cloudflare/mcp/session-store";

import type { CloudflareEnv } from "../config";
import { ErrorCaptureLive } from "../observability";

// ---------------------------------------------------------------------------
// Cloudflare McpSessionStore wiring — the SAME shared Durable-Object dispatcher
// as cloud (@executor-js/cloudflare), over host-cloudflare's `MCP_SESSION`
// namespace. The dispatch/identity/trace/peek logic all lives in the shared
// package; the host supplies ONLY its DO stub accessors (the session id IS the
// DO id, so every follow-up request routes back to the same isolate).
//
// This replaces the in-process store: an in-memory session map is invisible to
// the next Worker isolate, so `tools/list` after `initialize` failed in
// production ("Not connected"). The DO holds the session in one addressable
// isolate, fixing that across the board.
// ---------------------------------------------------------------------------

// The DO RPC stub structurally satisfies `McpSessionDOStub` (init/handleRequest/
// clearSession), but `@cloudflare/workers-types` types it as a generic
// `DurableObjectStub`. Narrow at this one boundary via an `unknown` hop — a
// single cast, so no double-cast through the worker-types stub type.
const toSessionStub = (stub: unknown): McpSessionDOStub => stub as McpSessionDOStub;

/** Build the DO-backed MCP session store over the host's `MCP_SESSION` namespace. */
export const makeCloudflareMcpSessionStore = (env: CloudflareEnv): Layer.Layer<McpSessionStore> =>
  makeDurableObjectMcpSessionStore({
    getStub: (sessionId) =>
      toSessionStub(env.MCP_SESSION.get(env.MCP_SESSION.idFromString(sessionId))),
    newStub: () => toSessionStub(env.MCP_SESSION.get(env.MCP_SESSION.newUniqueId())),
    // host-cf has no Sentry; a 500-defect surfaces through the reporter seam below.
  });

/** Route 500-defects through the host's console `ErrorCapture`. */
export const cloudflareMcpReporter: Layer.Layer<McpErrorReporter> =
  makeConsoleMcpErrorReporter(ErrorCaptureLive);
