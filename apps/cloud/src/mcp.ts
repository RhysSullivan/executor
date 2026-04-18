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
import { Context, Effect, Layer, Option, Schema } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { server } from "./env";
import { TelemetryLive } from "./services/telemetry";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHKIT_DOMAIN = server.MCP_AUTHKIT_DOMAIN;
const RESOURCE_ORIGIN = server.MCP_RESOURCE_ORIGIN;

const jwks = createRemoteJWKSet(new URL(`${AUTHKIT_DOMAIN}/oauth2/jwks`));

const BEARER_PREFIX = "Bearer ";

const CORS_ALLOW_ORIGIN = { "access-control-allow-origin": "*" } as const;

const CORS_PREFLIGHT_HEADERS = {
  ...CORS_ALLOW_ORIGIN,
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, mcp-session-id, accept, mcp-protocol-version",
  "access-control-expose-headers": "mcp-session-id",
} as const;

const WWW_AUTHENTICATE = `Bearer resource_metadata="${RESOURCE_ORIGIN}/.well-known/oauth-protected-resource"`;

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

export type VerifiedToken = {
  /** The WorkOS account ID (user ID). */
  accountId: string;
  /** The WorkOS organization ID, if the session has org context. */
  organizationId: string | null;
};

export class McpAuth extends Context.Tag("@executor/cloud/McpAuth")<
  McpAuth,
  {
    readonly verifyBearer: (request: Request) => Effect.Effect<VerifiedToken | null>;
  }
>() {}

export const McpAuthLive = Layer.succeed(McpAuth, {
  verifyBearer: (request) =>
    Effect.promise(async () => {
      const authHeader = request.headers.get("authorization");
      if (!authHeader?.startsWith(BEARER_PREFIX)) return null;
      try {
        const { payload } = await jwtVerify(authHeader.slice(BEARER_PREFIX.length), jwks, {
          issuer: AUTHKIT_DOMAIN,
        });
        if (!payload.sub) return null;
        return {
          accountId: payload.sub,
          organizationId: (payload.org_id as string | undefined) ?? null,
        };
      } catch {
        return null;
      }
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
});
type JsonRpcEnvelope = typeof JsonRpcEnvelope.Type;

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
  });

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
          "mcp.client.capability.keys": Object.keys(init.capabilities ?? {}).sort().join(","),
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

const rpcAttrs = (envelope: Option.Option<JsonRpcEnvelope>): Record<string, unknown> =>
  Option.match(envelope, {
    onNone: () => ({}),
    onSome: (e) => ({
      ...(e.method && { "mcp.rpc.method": e.method }),
      ...(e.id !== undefined && e.id !== null && { "mcp.rpc.id": String(e.id) }),
      ...methodAttrs(e),
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
  });

// ---------------------------------------------------------------------------
// OAuth metadata endpoints
// ---------------------------------------------------------------------------

const protectedResourceMetadata = Effect.sync(() =>
  jsonResponse({
    resource: RESOURCE_ORIGIN,
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
// DO dispatch
// ---------------------------------------------------------------------------

/**
 * Forward a request to an existing session DO. Wrapping the DO's `Response`
 * with `HttpServerResponse.raw` lets streaming bodies (SSE) pass through
 * `HttpApp.toWebHandler`'s conversion unchanged.
 */
const forwardToExistingSession = (request: Request, sessionId: string) =>
  Effect.promise(async () => {
    const ns = env.MCP_SESSION;
    const stub = ns.get(ns.idFromString(sessionId));
    return HttpServerResponse.raw(await stub.handleRequest(request));
  });

const dispatchPost = (request: Request, token: VerifiedToken) =>
  Effect.gen(function* () {
    const organizationId = token.organizationId;
    if (!organizationId) {
      return jsonRpcError(403, -32001, "No organization in session — log in via the web app first");
    }

    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) return yield* forwardToExistingSession(request, sessionId);

    return yield* Effect.promise(async () => {
      const ns = env.MCP_SESSION;
      const stub = ns.get(ns.newUniqueId());
      await stub.init({ organizationId });
      return HttpServerResponse.raw(await stub.handleRequest(request));
    });
  });

const dispatchGet = (request: Request) => {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) return Effect.succeed(jsonRpcError(400, -32000, "mcp-session-id header required for SSE"));
  return forwardToExistingSession(request, sessionId);
};

const dispatchDelete = (request: Request) => {
  const sessionId = request.headers.get("mcp-session-id");
  if (!sessionId) return Effect.succeed(HttpServerResponse.empty({ status: 204 }));
  return forwardToExistingSession(request, sessionId);
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
  if (pathname === "/mcp") return "mcp";
  if (pathname === "/.well-known/oauth-protected-resource") return "oauth-protected-resource";
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
      return yield* dispatchGet(request);
    case "DELETE":
      return yield* dispatchDelete(request);
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
