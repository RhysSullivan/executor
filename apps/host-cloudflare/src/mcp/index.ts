import type { Layer } from "effect";

import type { ExecutorDbHandle } from "@executor-js/api/server";
import type { McpAuthProvider, McpErrorReporter, McpSessionStore } from "@executor-js/host-mcp";

import type { CloudflareConfig } from "../config";
import { cloudflareAccessMcpAuth } from "./auth";
import {
  cloudflareMcpReporter,
  cloudflareMcpSessions,
  makeCloudflareMcpSessionStore,
} from "./session-store";

export { cloudflareAccessMcpAuth } from "./auth";
export {
  cloudflareMcpReporter,
  cloudflareMcpSessions,
  makeCloudflareMcpSessionStore,
} from "./session-store";

// ---------------------------------------------------------------------------
// The Cloudflare MCP serving seams, fed to `ExecutorApp.make`'s `mcp` group.
//
// `ExecutorApp.make` mounts the shared, provider-neutral MCP serving envelope
// (@executor-js/host-mcp) at the top-level `/mcp`, outside the API's execution
// middleware. The Cloudflare host provides the two envelope seams plus the
// error-reporter override:
//   - McpAuthProvider  -> `cloudflareAccessMcpAuth`: validate the Access JWT
//                         (same identity as the API gate); no MCP OAuth.
//   - McpSessionStore  -> `cloudflareMcpSessions`: the shared in-process store
//                         over the QuickJS engine + long-lived D1 handle.
//   - McpErrorReporter -> `cloudflareMcpReporter`: route 500 defects through the
//                         host's console capture.
// ---------------------------------------------------------------------------

export interface CloudflareMcpSeams {
  /** Validate the Access JWT to an MCP `AuthOutcome`; declares no discovery routes. */
  readonly auth: Layer.Layer<McpAuthProvider>;
  /** The in-process session store seam (dispatch + lifetime). */
  readonly sessions: Layer.Layer<McpSessionStore>;
  /** Route 500 defects through the host's console `ErrorCapture`. */
  readonly reporter: Layer.Layer<McpErrorReporter>;
  /** Dispose all live in-process MCP sessions at shutdown (not a seam). */
  readonly close: () => Promise<void>;
}

/**
 * Build the Cloudflare MCP serving seams over the long-lived D1 handle. Returns
 * the three seam Layers plus the `close()` lifetime hook (no-op on Workers,
 * where the isolate is torn down wholesale, but kept for parity with self-host).
 */
export const makeCloudflareMcpSeams = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
): CloudflareMcpSeams => {
  const sessionStore = makeCloudflareMcpSessionStore(config, dbHandle);
  return {
    auth: cloudflareAccessMcpAuth(config),
    sessions: cloudflareMcpSessions(sessionStore),
    reporter: cloudflareMcpReporter,
    close: sessionStore.close,
  };
};
