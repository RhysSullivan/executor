import { Effect, type Layer } from "effect";

import type { McpAuthProvider, McpErrorReporter, McpSessionStore } from "@executor-js/host-mcp";
import { decodeResumeResponse } from "@executor-js/host-mcp/browser-approval";
import type {
  McpApprovalOwner,
  McpSessionApprovalResult,
  McpSessionResumeApprovalResult,
} from "@executor-js/cloudflare/mcp/durable-object";
import type { ResumeResponse } from "@executor-js/execution";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import { makeAccessVerifier } from "../auth/cloudflare-access";
import { cloudflareAccessMcpAuth } from "./auth";
import { cloudflareMcpReporter, makeCloudflareMcpSessionStore } from "./session-store";

export { cloudflareAccessMcpAuth } from "./auth";
export { cloudflareMcpReporter, makeCloudflareMcpSessionStore } from "./session-store";
export { McpSessionDO } from "./session-durable-object";

// ---------------------------------------------------------------------------
// The Cloudflare MCP serving seams, fed to `ExecutorApp.make`'s `mcp` group.
//
// `ExecutorApp.make` mounts the shared, provider-neutral MCP serving envelope
// (@executor-js/host-mcp) at the top-level `/mcp`, outside the API's execution
// middleware. The Cloudflare host provides the two envelope seams plus the
// error-reporter override:
//   - McpAuthProvider  -> `cloudflareAccessMcpAuth`: validate the Access JWT
//                         (same identity as the API gate); no MCP OAuth.
//   - McpSessionStore  -> the shared Durable-Object dispatcher over the host's
//                         `MCP_SESSION` namespace (cross-isolate, same as cloud).
//   - McpErrorReporter -> `cloudflareMcpReporter`: route 500 defects through the
//                         host's console capture.
// ---------------------------------------------------------------------------

export interface CloudflareMcpSeams {
  /** Validate the Access JWT to an MCP `AuthOutcome`; declares no discovery routes. */
  readonly auth: Layer.Layer<McpAuthProvider>;
  /** The Durable-Object session store seam (dispatch + lifetime). */
  readonly sessions: Layer.Layer<McpSessionStore>;
  /** Route 500 defects through the host's console `ErrorCapture`. */
  readonly reporter: Layer.Layer<McpErrorReporter>;
  /**
   * The browser-approval HTTP handler, mounted by the app at
   * `/api/mcp-sessions/*`: an Access-gated web handler that reads paused-execution
   * detail (GET) and records the human's decision (POST `/resume`) for the console
   * resume page, routing each to the owning session's Durable Object RPCs.
   */
  readonly approvalHandler: (request: Request) => Promise<Response>;
}

// The MCP session Durable Object exposes the approval RPCs (the base class
// implements them); `@cloudflare/workers-types` types the stub generically, so
// narrow at this one boundary via a single `unknown`-param hop (same shape the
// session-store seam uses for the dispatch stub).
const toApprovalStub = (stub: unknown): McpApprovalStub => stub as McpApprovalStub;

interface McpApprovalStub {
  getPausedExecutionForApproval(
    executionId: string,
    identity: McpApprovalOwner,
  ): Promise<McpSessionApprovalResult>;
  resumeExecutionForApproval(
    executionId: string,
    identity: McpApprovalOwner,
    response: ResumeResponse,
  ): Promise<McpSessionResumeApprovalResult>;
}

const PAUSED_PATH = /^\/api\/mcp-sessions\/([^/?#]+)\/executions\/([^/?#]+)$/;
const RESUME_PATH = /^\/api\/mcp-sessions\/([^/?#]+)\/executions\/([^/?#]+)\/resume$/;

const jsonResponse = (value: unknown, status: number): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/**
 * Resolve the request to its Access principal (dev-auth → the fixed dev admin),
 * then route the browser-approval call to the owning session's Durable Object —
 * the same RPCs cloud serves through its HttpApi. The DO validates that the
 * principal owns the session before reading or resuming.
 */
const makeCloudflareApprovalHandler = (
  config: CloudflareConfig,
  env: CloudflareEnv,
): ((request: Request) => Promise<Response>) => {
  const { verify } = makeAccessVerifier(config);
  const stubFor = (sessionId: string): McpApprovalStub =>
    toApprovalStub(env.MCP_SESSION.get(env.MCP_SESSION.idFromString(sessionId)));

  return async (request) => {
    const principal = await Effect.runPromise(verify(request));
    if (!principal) return jsonResponse({ error: "Unauthorized" }, 401);
    const owner: McpApprovalOwner = {
      accountId: principal.accountId,
      organizationId: principal.organizationId,
    };
    const { pathname } = new URL(request.url);

    const paused = PAUSED_PATH.exec(pathname);
    if (paused && request.method === "GET") {
      const result = await stubFor(decodeURIComponent(paused[1]!)).getPausedExecutionForApproval(
        decodeURIComponent(paused[2]!),
        owner,
      );
      if (result.status !== "ok") return jsonResponse({ error: "Paused execution not found" }, 404);
      return jsonResponse({ text: result.text, structured: result.structured }, 200);
    }

    const resume = RESUME_PATH.exec(pathname);
    if (resume && request.method === "POST") {
      const raw = await Effect.runPromise(
        Effect.tryPromise({ try: () => request.json(), catch: () => null }).pipe(
          Effect.orElseSucceed(() => null),
        ),
      );
      const response = raw === null ? null : decodeResumeResponse(raw);
      if (!response) return jsonResponse({ error: "Invalid approval response" }, 400);

      const result = await stubFor(decodeURIComponent(resume[1]!)).resumeExecutionForApproval(
        decodeURIComponent(resume[2]!),
        owner,
        response,
      );
      if (result.status !== "ok") return jsonResponse({ error: "Paused execution not found" }, 404);
      return jsonResponse(
        {
          status: result.executionStatus,
          text: result.text,
          structured: result.structured,
          isError: result.isError ?? false,
        },
        200,
      );
    }

    return jsonResponse({ error: "Not found" }, 404);
  };
};

/**
 * Build the Cloudflare MCP serving seams over the host's `MCP_SESSION` Durable
 * Object namespace. No per-session DB handle is threaded here — each session DO
 * opens its own D1 handle in its own isolate.
 */
export const makeCloudflareMcpSeams = (
  config: CloudflareConfig,
  env: CloudflareEnv,
): CloudflareMcpSeams => ({
  auth: cloudflareAccessMcpAuth(config),
  sessions: makeCloudflareMcpSessionStore(env),
  reporter: cloudflareMcpReporter,
  approvalHandler: makeCloudflareApprovalHandler(config, env),
});
