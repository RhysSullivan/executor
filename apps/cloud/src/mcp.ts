// ---------------------------------------------------------------------------
// Cloud MCP handler — Effect-native HTTP app for /mcp + /.well-known/*
// ---------------------------------------------------------------------------
//
// Built on `@effect/platform`'s `HttpApp.toWebHandler`. start.ts's
// mcpRequestMiddleware calls `mcpFetch` and falls through to `next()` when it
// returns `null` (non-MCP path) so TanStack Start keeps routing.
//
// Streaming passthrough — the MCP session Durable Object returns a `Response`
// whose body is a `ReadableStream` (SSE). We wrap that `Response` in
// `HttpServerResponse.raw(response)`; the platform's `toWeb` conversion
// recognises `body.body instanceof Response` and returns it as-is (only
// merging headers we set on the outer response, which is none), so the
// underlying `ReadableStream` passes through untouched.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { HttpApp, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import * as Sentry from "@sentry/cloudflare";
import { Context, Effect, Either, Layer, Option, Schema } from "effect";
import { createRemoteJWKSet } from "jose";

import { TelemetryLive } from "./services/telemetry";
import { verifyMcpAccessToken, type VerifiedToken } from "./mcp-auth";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHKIT_DOMAIN = env.MCP_AUTHKIT_DOMAIN ?? "https://signin.executor.sh";
const RESOURCE_ORIGIN = env.MCP_RESOURCE_ORIGIN ?? "https://executor.sh";

const jwks = createRemoteJWKSet(new URL(`${AUTHKIT_DOMAIN}/oauth2/jwks`));

const BEARER_PREFIX = "Bearer ";
const INTERNAL_ACCOUNT_ID_HEADER = "x-executor-mcp-account-id";
const INTERNAL_ORGANIZATION_ID_HEADER = "x-executor-mcp-organization-id";

const CORS_ALLOW_ORIGIN = { "access-control-allow-origin": "*" } as const;

const CORS_PREFLIGHT_HEADERS = {
  ...CORS_ALLOW_ORIGIN,
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, mcp-session-id, accept, mcp-protocol-version",
  "access-control-expose-headers": "mcp-session-id",
} as const;

const MCP_PATH = "/mcp";
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const PROTECTED_RESOURCE_METADATA_URL = `${RESOURCE_ORIGIN}${PROTECTED_RESOURCE_METADATA_PATH}`;
const RESOURCE_URL = `${RESOURCE_ORIGIN}${MCP_PATH}`;

const WWW_AUTHENTICATE = [
  'Bearer error="unauthorized"',
  'error_description="Authorization needed"',
  `resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`,
].join(", ");

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200) =>
  HttpServerResponse.unsafeJson(body, { status, headers: CORS_ALLOW_ORIGIN });

const jsonRpcError = (status: number, code: number, message: string) =>
  HttpServerResponse.unsafeJson({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });

const unauthorized = HttpServerResponse.unsafeJson(
  { error: "unauthorized" },
  {
    status: 401,
    headers: { ...CORS_ALLOW_ORIGIN, "www-authenticate": WWW_AUTHENTICATE },
  },
);

const corsPreflight = HttpServerResponse.empty({
  status: 204,
  headers: CORS_PREFLIGHT_HEADERS,
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export class McpAuth extends Context.Tag("@executor/cloud/McpAuth")<
  McpAuth,
  {
    readonly verifyBearer: (request: Request) => Effect.Effect<VerifiedToken | null>;
  }
>() {}

const verifyJwt = (token: string) =>
  Effect.gen(function* () {
    const strictResult = yield* verifyMcpAccessToken(token, jwks, {
      issuer: AUTHKIT_DOMAIN,
      audience: RESOURCE_URL,
    }).pipe(Effect.either);

    if (Either.isRight(strictResult)) {
      return strictResult.right;
    }

    if (env.MCP_STRICT_AUDIENCE === "true") {
      return yield* Effect.fail(strictResult.left);
    }

    const verified = yield* verifyMcpAccessToken(token, jwks, {
      issuer: AUTHKIT_DOMAIN,
    });
    yield* Effect.annotateCurrentSpan({
      "mcp.auth.audience_fallback": true,
    });
    return verified;
  });

export const McpAuthLive = Layer.succeed(McpAuth, {
  verifyBearer: Effect.fn("mcp.auth.verify_bearer")(function* (request) {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith(BEARER_PREFIX)) {
      yield* Effect.annotateCurrentSpan({ "mcp.auth.outcome": "missing_bearer" });
      return null;
    }
    const verified = yield* verifyJwt(authHeader.slice(BEARER_PREFIX.length)).pipe(
      Effect.catchTag("McpJwtVerificationError", (error) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "mcp.auth.outcome": "invalid",
            "mcp.auth.invalid_reason": error.reason,
          });
          return null;
        }),
      ),
    );
    if (!verified) return null;
    if (!verified.accountId) {
      yield* Effect.annotateCurrentSpan({ "mcp.auth.outcome": "missing_subject" });
      return null;
    }
    yield* Effect.annotateCurrentSpan({
      "mcp.auth.outcome": "verified",
      "mcp.auth.has_organization": !!verified.organizationId,
    });
    return verified;
  }),
});

// ---------------------------------------------------------------------------
// Client fingerprint capture
// ---------------------------------------------------------------------------
// Annotates the Effect span (which nests under the otel-cf-workers fetch
// span) with everything we can learn about a connecting MCP client: the
// parsed JSON-RPC body, whitelisted request headers, CF request metadata,
// and verified-JWT claims. Lets us compare how each client (Claude Code,
// Claude.ai web, ChatGPT, custom scripts, ...) actually reports over the
// wire. Runs before dispatch so unauthorized requests still get fingerprinted.
// ---------------------------------------------------------------------------

type CfRequestMetadata = {
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
  asn?: number;
  asOrganization?: string;
  tlsVersion?: string;
  tlsCipher?: string;
  httpProtocol?: string;
  colo?: string;
};

const getCfMeta = (request: Request): CfRequestMetadata =>
  ((request as unknown as { cf?: CfRequestMetadata }).cf ?? {}) as CfRequestMetadata;

const HEADERS_TO_DUMP = [
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "origin",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
  "x-client-name",
  "x-client-version",
  "x-requested-with",
] as const;

const dumpHeaders = (request: Request): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of HEADERS_TO_DUMP) {
    const value = request.headers.get(name);
    if (value !== null) out[`mcp.http.header.${name}`] = value;
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    out["mcp.http.header.authorization.scheme"] = authHeader.split(" ", 1)[0] ?? "";
    out["mcp.http.header.authorization.length"] = String(authHeader.length);
  }
  // Record the full header name list too — surfaces anything unexpected
  // without us having to enumerate every possibility up front.
  out["mcp.http.header.names"] = Array.from(request.headers.keys()).sort().join(",");
  return out;
};

// JSON-RPC shapes — narrow to just the fields we fingerprint. Using Schema
// collapses the typeof-guard pile and surfaces "what does an MCP client
// actually send us" as declarative types. Unknown/malformed input decodes
// to None and contributes no span attrs.

const UnknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });

const JsonRpcEnvelope = Schema.Struct({
  method: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number, Schema.Null)),
  params: Schema.optional(UnknownRecord),
  // Responses to server-initiated requests arrive as POST bodies too —
  // notably elicitation replies (`result.action = "accept" | "decline" | "cancel"`).
  result: Schema.optional(UnknownRecord),
});
type JsonRpcEnvelope = typeof JsonRpcEnvelope.Type;

const ElicitationReplyResult = Schema.Struct({
  action: Schema.optional(Schema.Literal("accept", "decline", "cancel")),
});

const InitializeParams = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
  clientInfo: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
  capabilities: Schema.optional(UnknownRecord),
});

const NamedParams = Schema.Struct({ name: Schema.optional(Schema.String) });
const UriParams = Schema.Struct({ uri: Schema.optional(Schema.String) });

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Option.Option<A> =>
  Schema.decodeUnknownOption(schema)(input);

const readJsonRpcEnvelope = (request: Request): Effect.Effect<Option.Option<JsonRpcEnvelope>> =>
  Effect.promise(async () => {
    try {
      const text = await request.clone().text();
      if (!text) return Option.none();
      return decode(JsonRpcEnvelope, JSON.parse(text));
    } catch {
      return Option.none();
    }
  }).pipe(Effect.withSpan("mcp.request.read_json_rpc"));

const methodAttrs = (envelope: JsonRpcEnvelope): Record<string, unknown> => {
  const params = envelope.params ?? {};
  switch (envelope.method) {
    case "initialize":
      return Option.match(decode(InitializeParams, params), {
        onNone: () => ({}),
        onSome: (init) => ({
          ...(init.protocolVersion && { "mcp.client.protocol_version": init.protocolVersion }),
          ...(init.clientInfo?.name && { "mcp.client.name": init.clientInfo.name }),
          ...(init.clientInfo?.version && { "mcp.client.version": init.clientInfo.version }),
          ...(init.clientInfo?.title && { "mcp.client.title": init.clientInfo.title }),
          "mcp.client.capability.keys": Object.keys(init.capabilities ?? {})
            .sort()
            .join(","),
        }),
      });
    case "tools/call":
      return Option.match(decode(NamedParams, params), {
        onNone: () => ({}),
        onSome: ({ name }) => (name ? { "mcp.tool.name": name } : {}),
      });
    case "resources/read":
    case "resources/subscribe":
      return Option.match(decode(UriParams, params), {
        onNone: () => ({}),
        onSome: ({ uri }) => (uri ? { "mcp.resource.uri": uri } : {}),
      });
    case "prompts/get":
      return Option.match(decode(NamedParams, params), {
        onNone: () => ({}),
        onSome: ({ name }) => (name ? { "mcp.prompt.name": name } : {}),
      });
    default:
      return {};
  }
};

const replyAttrs = (envelope: JsonRpcEnvelope): Record<string, unknown> => {
  if (!envelope.result || envelope.method) return {};
  return Option.match(decode(ElicitationReplyResult, envelope.result), {
    onNone: () => ({}),
    onSome: ({ action }) => (action ? { "mcp.elicitation.action": action } : {}),
  });
};

const rpcAttrs = (envelope: Option.Option<JsonRpcEnvelope>): Record<string, unknown> =>
  Option.match(envelope, {
    onNone: () => ({}),
    onSome: (e) => ({
      ...(e.method && { "mcp.rpc.method": e.method }),
      ...(e.id !== undefined && e.id !== null && { "mcp.rpc.id": String(e.id) }),
      ...methodAttrs(e),
      ...replyAttrs(e),
    }),
  });

const annotateMcpRequest = (
  request: Request,
  opts: { token: VerifiedToken | null; parseBody: boolean },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cf = getCfMeta(request);
    const baseAttrs: Record<string, unknown> = {
      "mcp.request.method": request.method,
      "mcp.request.session_id_present": !!request.headers.get("mcp-session-id"),
      "mcp.request.session_id": request.headers.get("mcp-session-id") ?? "",
      "mcp.auth.has_bearer": (request.headers.get("authorization") ?? "").startsWith(BEARER_PREFIX),
      "mcp.auth.verified": !!opts.token,
      "mcp.auth.organization_id": opts.token?.organizationId ?? "",
      "mcp.auth.account_id": opts.token?.accountId ?? "",
      "cf.country": cf.country ?? "",
      "cf.city": cf.city ?? "",
      "cf.region": cf.region ?? "",
      "cf.timezone": cf.timezone ?? "",
      "cf.asn": cf.asn ?? 0,
      "cf.as_organization": cf.asOrganization ?? "",
      "cf.tls_version": cf.tlsVersion ?? "",
      "cf.tls_cipher": cf.tlsCipher ?? "",
      "cf.http_protocol": cf.httpProtocol ?? "",
      "cf.colo": cf.colo ?? "",
      ...dumpHeaders(request),
    };

    const envelope = opts.parseBody ? yield* readJsonRpcEnvelope(request) : Option.none();

    yield* Effect.annotateCurrentSpan({
      ...baseAttrs,
      ...rpcAttrs(envelope),
    });
  }).pipe(
    Effect.withSpan("mcp.request.annotate", {
      attributes: {
        "mcp.request.method": request.method,
        "mcp.request.parse_body": opts.parseBody,
      },
    }),
  );

// ---------------------------------------------------------------------------
// OAuth metadata endpoints
// ---------------------------------------------------------------------------

const protectedResourceMetadata = Effect.sync(() =>
  jsonResponse({
    resource: RESOURCE_URL,
    authorization_servers: [AUTHKIT_DOMAIN],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
  }),
);

const authorizationServerMetadata = Effect.promise(async () => {
  try {
    const res = await fetch(`${AUTHKIT_DOMAIN}/.well-known/oauth-authorization-server`);
    if (!res.ok) return jsonResponse({ error: "upstream_error" }, 502);
    return jsonResponse(await res.json());
  } catch {
    return jsonResponse({ error: "upstream_error" }, 502);
  }
});

// ---------------------------------------------------------------------------
// Response-body peek for JSON-RPC error attrs
// ---------------------------------------------------------------------------
//
// The MCP protocol wraps protocol-level failures (malformed envelope, method
// not found, invalid params) as `{ error: { code, message } }` in the
// JSON-RPC response body with HTTP 200 — none of which surface at the HTTP
// layer or as an Effect failure. Same for tool results carrying
// `isError: true`. To make those visible in Axiom we peek the first
// JSON-RPC message out of the DO's response and stamp it onto the
// surrounding `mcp.request` span.
//
// Only applied to non-streaming response shapes (POST/DELETE). GET hops
// onto a long-lived SSE channel we don't want to consume.
// ---------------------------------------------------------------------------

type SandboxOutcome = {
  readonly status?: string;
  readonly error?: { readonly kind?: string; readonly message?: string };
};

type JsonRpcErrorBody = {
  readonly jsonrpc?: string;
  readonly error?: { readonly code?: number; readonly message?: string };
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: SandboxOutcome;
  };
};

const responseBodyShape = (body: string): string => {
  const trimmed = body.trimStart();
  if (!trimmed) return "empty";
  if (trimmed.startsWith("{")) return "json-object";
  if (trimmed.startsWith("[")) return "json-array";
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) return "sse";
  if (trimmed.startsWith("<")) return "html-or-xml";
  return "other";
};

const parseFirstJsonRpc = (contentType: string, body: string): JsonRpcErrorBody | null => {
  if (!body) return null;
  try {
    if (contentType.includes("text/event-stream")) {
      // Grab the first `data:` line from the first SSE event.
      for (const line of body.split(/\r?\n/)) {
        if (line.startsWith("data:")) return JSON.parse(line.slice(5).trimStart());
      }
      return null;
    }
    if (contentType.includes("application/json")) {
      return JSON.parse(body);
    }
    return null;
  } catch {
    return null;
  }
};

const rpcResponseAttrs = (payload: JsonRpcErrorBody | null): Record<string, unknown> => {
  // Require a JSON-RPC 2.0 envelope so we don't false-positive on other
  // JSON shapes the edge happens to return (e.g. the auth-failure body
  // `{ "error": "unauthorized" }` — not a JSON-RPC error).
  if (!payload || payload.jsonrpc !== "2.0") return {};
  const attrs: Record<string, unknown> = {};
  const err = payload.error;
  if (err && typeof err === "object") {
    attrs["mcp.rpc.is_error"] = true;
    if (typeof err.code === "number") attrs["mcp.rpc.error.code"] = err.code;
    if (typeof err.message === "string") {
      attrs["mcp.rpc.error.message"] = err.message.slice(0, 500);
    }
  }
  if (payload.result?.isError === true) {
    attrs["mcp.tool.result.is_error"] = true;
  }
  const sc = payload.result?.structuredContent;
  if (sc && typeof sc.status === "string") {
    attrs["mcp.tool.sandbox.status"] = sc.status;
    if (sc.error?.kind) attrs["mcp.tool.sandbox.error.kind"] = sc.error.kind;
    if (typeof sc.error?.message === "string") {
      attrs["mcp.tool.sandbox.error.message"] = sc.error.message.slice(0, 500);
    }
  }
  return attrs;
};

const peekAndAnnotate = (response: Response): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 202) {
      // MCP Streamable HTTP accepts notification-only POSTs with 202 and no body.
      yield* Effect.annotateCurrentSpan({
        "mcp.response.status_code": response.status,
        "mcp.response.content_type": contentType,
        "mcp.response.body.shape": "empty",
        "mcp.response.body.length": 0,
        "mcp.response.jsonrpc.detected": false,
      });
      const headers = new Headers(response.headers);
      headers.delete("content-type");
      headers.delete("content-length");
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (!response.body) {
      yield* Effect.annotateCurrentSpan({
        "mcp.response.status_code": response.status,
        "mcp.response.content_type": contentType,
        "mcp.response.body.shape": "empty",
        "mcp.response.body.length": 0,
        "mcp.response.jsonrpc.detected": false,
      });
      return response;
    }
    // The DO can return a streaming SSE response for older in-memory
    // sessions, so `response.text()` blocks on the
    // entire downstream execution — RPC into the dynamic Worker, tool
    // invocations back to the host, result serialisation. Carving this
    // into its own span pins "worker drain time" on the trace so you can
    // tell worker-side waiting apart from any pre/post work on the edge.
    const text = yield* Effect.promise(() => response.text()).pipe(
      Effect.withSpan("mcp.peek_response", {
        attributes: {
          "http.response.content_type": contentType,
          "http.response.status_code": response.status,
        },
      }),
    );
    const payload = parseFirstJsonRpc(contentType, text);
    yield* Effect.annotateCurrentSpan({
      "mcp.response.status_code": response.status,
      "mcp.response.content_type": contentType,
      "mcp.response.body.length": text.length,
      "mcp.response.body.shape": responseBodyShape(text),
      "mcp.response.jsonrpc.detected": payload?.jsonrpc === "2.0",
    });
    const attrs = rpcResponseAttrs(payload);
    if (Object.keys(attrs).length > 0) {
      yield* Effect.annotateCurrentSpan(attrs);
    }
    // Internal-error code -32603 means our server failed handling a
    // structurally valid request. Unlike -32601 / -32602 ("the client
    // fucked up"), this is a real bug in our code — route to Sentry so
    // we get alerted. Protocol-level client errors stay in Axiom.
    if (payload?.error?.code === -32603) {
      yield* Effect.sync(() => {
        const msg = payload.error?.message ?? "unknown";
        Sentry.captureException(new Error(`MCP internal error (-32603): ${msg}`));
      });
    }
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });

// ---------------------------------------------------------------------------
// DO dispatch
// ---------------------------------------------------------------------------

// Worker and DO run in separate isolates with independent WebSdk tracer
// providers. Neither one can see the other's OTEL context, so the DO used
// to emit a brand-new root trace on every stub call. Ferry the worker span
// context across with W3C headers: `traceparent` generated from the active
// Effect span plus passthrough `tracestate` / `baggage` from the inbound
// request.
type IncomingPropagationHeaders = {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
};

const currentTraceparent = Effect.map(Effect.currentSpan, (span) => {
  if (!span || !span.traceId || !span.spanId) return undefined;
  const flags = span.sampled ? "01" : "00";
  return `00-${span.traceId}-${span.spanId}-${flags}`;
}).pipe(Effect.orElseSucceed(() => undefined));

const currentPropagationHeaders = (request: Request): Effect.Effect<IncomingPropagationHeaders> =>
  Effect.map(currentTraceparent, (traceparent) => ({
    traceparent,
    tracestate: request.headers.get("tracestate") ?? undefined,
    baggage: request.headers.get("baggage") ?? undefined,
  }));

const withPropagationHeaders = (
  request: Request,
  propagation: IncomingPropagationHeaders,
): Request => {
  const headers = new Headers(request.headers);
  if (propagation.traceparent) {
    headers.set("traceparent", propagation.traceparent);
  }
  if (propagation.tracestate) {
    headers.set("tracestate", propagation.tracestate);
  }
  if (propagation.baggage) {
    headers.set("baggage", propagation.baggage);
  }
  return new Request(request, { headers });
};

const withVerifiedIdentityHeaders = (request: Request, token: VerifiedToken): Request => {
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_ACCOUNT_ID_HEADER, token.accountId);
  headers.set(INTERNAL_ORGANIZATION_ID_HEADER, token.organizationId ?? "");
  return new Request(request, { headers });
};

const withMcpResponseHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "mcp-session-id");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * Forward a request to an existing session DO. Wrapping the DO's `Response`
 * with `HttpServerResponse.raw` lets streaming bodies (SSE) pass through
 * `HttpApp.toWebHandler`'s conversion unchanged.
 */
const forwardToExistingSession = (
  request: Request,
  sessionId: string,
  peek: boolean,
  token: VerifiedToken,
) =>
  Effect.gen(function* () {
    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.idFromString(sessionId));
    const propagation = yield* currentPropagationHeaders(request);
    const propagated = withPropagationHeaders(
      withVerifiedIdentityHeaders(request, token),
      propagation,
    );
    const raw = yield* Effect.promise(
      () => stub.handleRequest(propagated) as Promise<Response>,
    ).pipe(
      Effect.withSpan("mcp.do.handle_request", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": true,
        },
      }),
    );
    const annotated = peek ? yield* peekAndAnnotate(raw) : raw;
    return HttpServerResponse.raw(withMcpResponseHeaders(annotated));
  });

const dispatchPost = (request: Request, token: VerifiedToken) =>
  Effect.gen(function* () {
    const organizationId = token.organizationId;
    if (!organizationId) {
      return jsonRpcError(403, -32001, "No organization in session — log in via the web app first");
    }

    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) return yield* forwardToExistingSession(request, sessionId, true, token);

    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.newUniqueId());
    const propagation = yield* currentPropagationHeaders(request);
    yield* Effect.promise(() =>
      stub.init({ organizationId, userId: token.accountId }, propagation),
    ).pipe(
      Effect.withSpan("mcp.do.init", {
        attributes: { "mcp.request.session_id_present": false },
      }),
    );
    const propagated = withPropagationHeaders(
      withVerifiedIdentityHeaders(request, token),
      propagation,
    );
    const raw = yield* Effect.promise(
      () => stub.handleRequest(propagated) as Promise<Response>,
    ).pipe(
      Effect.withSpan("mcp.do.handle_request", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": false,
        },
      }),
    );
    const annotated = yield* peekAndAnnotate(raw);
    return HttpServerResponse.raw(withMcpResponseHeaders(annotated));
  });

const dispatchGet = (request: Request, token: VerifiedToken) => {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId)
    return Effect.succeed(jsonRpcError(400, -32000, "mcp-session-id header required for SSE"));
  return forwardToExistingSession(request, sessionId, false, token);
};

const dispatchDelete = (request: Request, token: VerifiedToken) => {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) return Effect.succeed(HttpServerResponse.empty({ status: 204 }));
  return forwardToExistingSession(request, sessionId, true, token);
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

type McpRoute = "mcp" | "oauth-protected-resource" | "oauth-authorization-server" | null;

/**
 * Returns the MCP route type for a pathname, or `null` if the path isn't owned
 * by the MCP handler.
 *
 * Exported so the test worker can share the exact same predicate the middleware
 * uses — we avoid duplicating the "is this an MCP path?" logic across entry
 * points.
 */
export const classifyMcpPath = (pathname: string): McpRoute => {
  if (pathname === MCP_PATH) return "mcp";
  if (pathname === PROTECTED_RESOURCE_METADATA_PATH) return "oauth-protected-resource";
  if (pathname === "/.well-known/oauth-authorization-server") return "oauth-authorization-server";
  return null;
};

/**
 * Raw Effect-native MCP app. Exported so alternate entry points (e.g. the
 * vitest-pool-workers test worker) can provide their own `McpAuth` layer —
 * the only dependency we deliberately swap in tests because hitting the real
 * WorkOS JWKS isn't practical. Every other layer stays real.
 */
export const mcpApp: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | McpAuth
> = Effect.gen(function* () {
  const httpRequest = yield* HttpServerRequest.HttpServerRequest;
  const request = httpRequest.source as Request;
  const route = classifyMcpPath(new URL(request.url).pathname);

  if (request.method === "OPTIONS") return corsPreflight;
  if (route === "oauth-protected-resource") return yield* protectedResourceMetadata;
  if (route === "oauth-authorization-server") return yield* authorizationServerMetadata;

  const auth = yield* McpAuth;
  const token = yield* auth.verifyBearer(request);

  // Annotate before dispatch so even 401s show up with what we know. Only
  // POST bodies are JSON-RPC payloads worth parsing; GET (SSE) and DELETE
  // don't carry one.
  yield* annotateMcpRequest(request, { token, parseBody: request.method === "POST" });

  if (!token) return unauthorized;
  switch (request.method) {
    case "POST":
      return yield* dispatchPost(request, token);
    case "GET":
      return yield* dispatchGet(request, token);
    case "DELETE":
      return yield* dispatchDelete(request, token);
    default:
      return jsonRpcError(405, -32001, "Method not allowed");
  }
}).pipe(
  Effect.withSpan("mcp.request"),
  Effect.catchAllCause((cause) =>
    Effect.sync(() => {
      console.error("[mcp] request failed:", cause);
      Sentry.captureException(cause);
      return jsonRpcError(500, -32603, "Internal server error");
    }),
  ),
);

const rawMcpFetch = HttpApp.toWebHandler(
  mcpApp.pipe(Effect.provide(Layer.mergeAll(McpAuthLive, TelemetryLive))),
);

/**
 * Fetch handler for /mcp + /.well-known/* paths.
 *
 * Returns `null` when the path doesn't match a known MCP route so the caller
 * (`start.ts`'s mcpRequestMiddleware) can fall through to `next()` and let
 * TanStack Start handle normal routing — e.g. an unknown `/.well-known/*`
 * path that should 404 through the regular route tree.
 */
export const mcpFetch = async (request: Request): Promise<Response | null> => {
  if (classifyMcpPath(new URL(request.url).pathname) === null) return null;
  return rawMcpFetch(request);
};
