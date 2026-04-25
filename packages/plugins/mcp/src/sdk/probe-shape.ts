// ---------------------------------------------------------------------------
// MCP endpoint shape probe — decide whether an unknown HTTP endpoint is
// actually speaking MCP before we try to classify it as such.
//
// Background:
//
//   `discoverTools` (via the MCP SDK's StreamableHTTP / SSE transport)
//   fails for every non-MCP endpoint too — 200-with-HTML, 400-GraphQL,
//   404, etc. all surface as the same opaque transport error. When
//   `discoverTools` fails, plugin.ts falls through to
//   `startMcpOAuthAuthorization`, which succeeds against *any* URL whose
//   origin publishes OAuth 2.0 Protected Resource + Authorization Server
//   Metadata (RFC 9728 + RFC 8414) — that's what the MCP SDK's `auth()`
//   consumes. Plenty of non-MCP APIs (Railway's `backboard.railway.com/
//   graphql/v2`, anything backed by a standards-compliant OAuth AS)
//   publish that metadata, so the fall-through misclassifies them.
//
// The MCP authorization spec (`modelcontextprotocol.io/specification/
// draft/basic/authorization`) mandates the handshake that distinguishes
// a real MCP-requires-OAuth endpoint from the general case:
//
//   - On an unauthenticated request the server MUST respond `401` and
//     include `WWW-Authenticate: Bearer` with a `resource_metadata=`
//     attribute pointing at its RFC 9728 document.
//
// This module issues an unauth JSON-RPC `initialize` POST and checks
// exactly that shape. That's enough to separate "MCP server that needs
// OAuth" from "non-MCP service whose host happens to publish OAuth
// metadata". It's a single `fetch`, no MCP-SDK session state, no OAuth
// round-trip, no DCR — every non-MCP endpoint exits here.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

/** MCP initialize request body used as the shape probe. Any real MCP
 *  server either answers it (unauth-OK server) or returns the spec-
 *  mandated 401 + WWW-Authenticate pair. A non-MCP endpoint hit with
 *  this body will respond with whatever it does for unknown JSON
 *  payloads — 400, 404, HTML, a GraphQL error envelope, etc. — none of
 *  which match the gate below. */
const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "executor-probe", version: "0" },
  },
});

/** Header-name lookup is case-insensitive per RFC 7230. `fetch`'s
 *  `Response.headers` already lower-cases, but we normalise explicitly
 *  to stay robust against test mocks that construct `Headers` loosely. */
const readHeader = (headers: Headers, name: string): string | null => {
  const direct = headers.get(name);
  if (direct !== null) return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
};

export type McpShapeProbeResult =
  /** Server answered initialize successfully — either a 2xx with a
   *  JSON-RPC payload, or a 401 + WWW-Authenticate: Bearer (RFC 6750
   *  challenge) that the MCP auth spec requires. */
  | { readonly kind: "mcp"; readonly requiresAuth: boolean }
  /** Endpoint is reachable but the response does not look like MCP. */
  | { readonly kind: "not-mcp"; readonly reason: string }
  /** Transport-level failure (DNS, TLS, timeout, abort, ...). */
  | { readonly kind: "unreachable"; readonly reason: string };

export interface ProbeOptions {
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Abort the request after this many ms. Default 8000. */
  readonly timeoutMs?: number;
}

/**
 * Hit `endpoint` with a JSON-RPC `initialize` POST and classify the
 * response according to the MCP authorization spec.
 *
 * Returns `{kind: "mcp"}` only when the endpoint either:
 *   - answers with 2xx (unauth-OK MCP server), or
 *   - responds 401 with a `Bearer` WWW-Authenticate challenge.
 *
 * Anything else (400, 404, 200-with-HTML, 200-with-GraphQL-errors, ...)
 * is classified `not-mcp`. Transport errors surface as `unreachable`.
 */
export const probeMcpEndpointShape = (
  endpoint: string,
  options: ProbeOptions = {},
): Effect.Effect<McpShapeProbeResult> =>
  Effect.gen(function* () {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? 8_000;

    const outcome = yield* Effect.tryPromise({
      try: async (): Promise<McpShapeProbeResult> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: INITIALIZE_BODY,
            signal: controller.signal,
          });

          if (response.status === 401) {
            const wwwAuth = readHeader(response.headers, "www-authenticate");
            if (wwwAuth && /^\s*bearer\b/i.test(wwwAuth)) {
              return { kind: "mcp", requiresAuth: true };
            }
            return {
              kind: "not-mcp",
              reason:
                "401 without Bearer WWW-Authenticate — not an MCP auth challenge",
            };
          }

          if (response.status >= 200 && response.status < 300) {
            // Streamable-HTTP servers may answer with `text/event-stream`;
            // either way the status alone is enough to rule in the
            // "MCP, unauth OK" case. The full JSON-RPC decode happens in
            // `discoverTools` — this probe only needs to confirm shape.
            return { kind: "mcp", requiresAuth: false };
          }

          return {
            kind: "not-mcp",
            reason: `unexpected status ${response.status} for initialize`,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.succeed<McpShapeProbeResult>({
          kind: "unreachable",
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    );

    return outcome;
  }).pipe(Effect.withSpan("mcp.plugin.probe_shape"));
