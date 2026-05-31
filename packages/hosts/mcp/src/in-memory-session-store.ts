import { Data, Effect, Layer } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { jsonRpcErrorBody } from "./envelope";
import {
  McpSessionStore,
  principalOwns,
  type McpDispatchInput,
  type McpDispatchResult,
  type Principal,
} from "./seams";

// ---------------------------------------------------------------------------
// In-process McpSessionStore — the single-node serving store, shared by every
// host that has no cross-isolate session backend (self-host, the Cloudflare
// QuickJS host). Cloud's Durable Object store is the cross-isolate variant of
// the same `McpSessionStore` seam.
//
// In the two-seam envelope the store owns the ENTIRE session lifecycle via
// `dispatch`: create (no session id + POST initialize), forward (session id
// present), and ownership (cross-bearer). Three Maps keyed by mcp-session-id —
// transports, servers, owners — hold the live in-process sessions. Closing a
// session is just closing its transport + server.
//
// The engine is a store implementation detail, not an envelope seam: the store
// builds each per-session `McpServer` through the host-supplied `buildServer`
// (the host's execution stack over its own DB + code substrate). The two-seam
// envelope has no engine seam — the store owns engine construction.
//
// `dispatch` returns the transport `Response` to pass through, or:
//   - "not-found" (unknown session id)              -> envelope renders 404 -32001
//   - "forbidden" (session owned by another bearer) -> envelope renders 403 -32003
// ---------------------------------------------------------------------------

/** Engine construction failed for a principal. The store surfaces it as a 500. */
export class McpEngineBuildError extends Data.TaggedError("McpEngineBuildError")<{
  readonly cause: unknown;
}> {}

/** Build the per-session `McpServer` for a principal (the host's engine + tools). */
export type McpBuildServer = (
  principal: Principal,
) => Effect.Effect<McpServer, McpEngineBuildError>;

export interface InMemoryMcpSessionStore {
  /** The `McpSessionStore` seam value to hand to `inMemoryMcpSessionsLayer`. */
  readonly store: McpSessionStore["Service"];
  /** Dispose every live session — wire into the host's shutdown (not a seam). */
  readonly close: () => Promise<void>;
}

const ignoreClose = (close: (() => Promise<void>) | undefined): Promise<void> =>
  close
    ? Effect.runPromise(Effect.ignore(Effect.tryPromise({ try: close, catch: () => undefined })))
    : Promise.resolve();

const formatBoundaryError = (error: unknown): unknown =>
  // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: log unknown MCP SDK/runtime failures
  error instanceof Error ? (error.stack ?? error.message) : error;

// The store's error bodies are INNER responses (no CORS): the serving envelope
// re-wraps the store `Response` with CORS before it leaves the origin, so the
// canonical renderer is called with `cors: false` (content-type only).
const jsonRpcError = (status: number, code: number, message: string): Response =>
  jsonRpcErrorBody(status, code, message, { cors: false });

/**
 * Build the in-process session store plus an explicit `close()` that disposes
 * all live sessions. `close()` is not part of the seam — it is the host lifetime
 * hook the envelope doesn't own. Each per-session engine comes from the
 * host-supplied `buildServer`.
 */
export const makeInMemoryMcpSessionStore = (
  buildServer: McpBuildServer,
): InMemoryMcpSessionStore => {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const owners = new Map<string, Principal>();

  const dispose = async (id: string, opts: { transport?: boolean; server?: boolean } = {}) => {
    const transport = transports.get(id);
    const server = servers.get(id);
    transports.delete(id);
    servers.delete(id);
    owners.delete(id);
    if (opts.transport) await ignoreClose(transport ? () => transport.close() : undefined);
    if (opts.server) await ignoreClose(server ? () => server.close() : undefined);
  };

  /**
   * Drive a transport for one web request, recovering any defect to a 500. On a
   * fresh transport that never minted a session id (e.g. a non-initialize first
   * request), close it and its server eagerly so they don't leak.
   */
  const runHandleRequest = (
    transport: WebStandardStreamableHTTPServerTransport,
    request: Request,
    onClose?: () => void,
  ): Effect.Effect<Response> => {
    const finish = (): void => {
      if (onClose && !transport.sessionId) onClose();
    };
    return Effect.promise(() => transport.handleRequest(request)).pipe(
      Effect.tap(() => Effect.sync(finish)),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error("[mcp] handleRequest error:", formatBoundaryError(cause));
          finish();
          return jsonRpcError(500, -32603, "Internal server error");
        }),
      ),
    );
  };

  /** Forward to an existing session, enforcing ownership against the principal. */
  const forward = (
    sessionId: string,
    principal: Principal,
    request: Request,
  ): Effect.Effect<McpDispatchResult> => {
    const transport = transports.get(sessionId);
    const owner = owners.get(sessionId);
    if (!transport || !owner) return Effect.succeed("not-found");
    if (!principalOwns(owner, principal)) return Effect.succeed("forbidden");
    return runHandleRequest(transport, request);
  };

  /** Open a new session: build the server, connect a transport, drive the request. */
  const create = (principal: Principal, request: Request): Effect.Effect<McpDispatchResult> =>
    buildServer(principal).pipe(
      Effect.flatMap((server) =>
        Effect.gen(function* () {
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
              servers.set(sid, server);
              owners.set(sid, principal);
            },
            onsessionclosed: (sid) => void dispose(sid, { server: true }),
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) void dispose(sid, { server: true });
          };
          yield* Effect.promise(() => server.connect(transport));
          // The session id is minted on the first (initialize) request, so we
          // drive `handleRequest` here; if no id results we close eagerly.
          return yield* runHandleRequest(transport, request, () => {
            void ignoreClose(() => transport.close());
            void ignoreClose(() => server.close());
          });
        }),
      ),
      // A build failure has nowhere typed to go in the envelope; render a 500.
      Effect.catchTag("McpEngineBuildError", () =>
        Effect.succeed(jsonRpcError(500, -32603, "Internal server error")),
      ),
    );

  const store: McpSessionStore["Service"] = {
    dispatch: ({ request, principal, sessionId }: McpDispatchInput) =>
      sessionId ? forward(sessionId, principal, request) : create(principal, request),
    dispose: (sessionId) =>
      Effect.promise(() => dispose(sessionId, { transport: true, server: true })),
  };

  return {
    store,
    close: async () => {
      const ids = new Set([...transports.keys(), ...servers.keys()]);
      await Promise.all([...ids].map((id) => dispose(id, { transport: true, server: true })));
    },
  };
};

/**
 * Layer wrapping a freshly built in-process store, the `McpSessionStore`
 * envelope seam. The owning app calls `makeInMemoryMcpSessionStore(buildServer)`
 * directly so it can wire the `close()` lifetime hook into shutdown, then passes
 * the built store here.
 */
export const inMemoryMcpSessionsLayer = (
  built: InMemoryMcpSessionStore,
): Layer.Layer<McpSessionStore> => Layer.succeed(McpSessionStore)(built.store);
