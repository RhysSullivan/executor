// ---------------------------------------------------------------------------
// MCP Session Durable Object — holds MCP server + engine per session
// ---------------------------------------------------------------------------

import { DurableObject, env } from "cloudflare:workers";
import { createTraceState } from "@opentelemetry/api";
import { Data, Effect, Layer } from "effect";
import * as OtelTracer from "@effect/opentelemetry/Tracer";
import type * as Tracer from "effect/Tracer";
import * as Sentry from "@sentry/cloudflare";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkerTransport, type TransportState } from "agents/mcp";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createExecutorMcpServer } from "@executor/host-mcp";
import { buildExecuteDescription } from "@executor/execution";
import type { DrizzleDb, DbServiceShape } from "./services/db";

// Import directly from core-shared-services, NOT from ./api/layers.ts.
// The full layers module pulls in `auth/handlers.ts` → `@tanstack/react-start/server`,
// which uses a `#tanstack-start-entry` subpath specifier that breaks module
// load under vitest-pool-workers. The DO only needs the core two services
// (WorkOSAuth + AutumnService), so we import them from the tight module.
import { CoreSharedServices } from "./api/core-shared-services";
import { UserStoreService } from "./auth/context";
import { resolveOrganization } from "./auth/resolve-organization";
import { server } from "./env";
import { DbService, combinedSchema } from "./services/db";
import { makeExecutionStack } from "./services/execution-stack";
import { DoTelemetryLive } from "./services/telemetry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpSessionInit = {
  organizationId: string;
};

export type IncomingTraceHeaders = {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
};

const HEARTBEAT_MS = 30 * 1000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const TRANSPORT_STATE_KEY = "transport";
const SESSION_META_KEY = "session-meta";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class OrganizationNotFoundError extends Data.TaggedError("OrganizationNotFoundError")<{
  readonly organizationId: string;
}> {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });

// W3C propagation across the worker→DO boundary. mcp.ts injects the worker's
// `traceparent` and forwards incoming `tracestate` / `baggage` headers on
// forwarded requests (and as a second arg to `init()`). We parse the context
// here and use `OtelTracer.withSpanContext` to stitch the DO's root span
// under the worker span so the entire logical request lives in one trace.
const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

type IncomingSpanContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceState?: ReturnType<typeof createTraceState>;
};

const parseTraceparent = (
  traceparent: string | null | undefined,
  tracestate: string | null | undefined,
): IncomingSpanContext | null => {
  const value = traceparent;
  if (!value) return null;
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match) return null;
  return {
    traceId: match[2]!,
    spanId: match[3]!,
    traceFlags: parseInt(match[4]!, 16),
    ...(tracestate ? { traceState: createTraceState(tracestate) } : {}),
  };
};

const withIncomingParent = <A, E, R>(
  incoming: IncomingTraceHeaders | null | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const parsed = parseTraceparent(incoming?.traceparent, incoming?.tracestate);
  return parsed ? OtelTracer.withSpanContext(effect, parsed) : effect;
};

type DbHandle = DbServiceShape & { end: () => Promise<void> };
type SessionMeta = {
  readonly organizationId: string;
  readonly organizationName: string;
};

/**
 * Base DB handle factory for MCP session runtimes.
 *
 * The production DO keeps one postgres.js socket for the session lifetime.
 * The workerd test pool rejects that socket on the next request because the
 * underlying I/O object is request-bound. Tests therefore opt into a
 * request-scoped runtime and rebuild the server + DB handle per POST/DELETE
 * while keeping only the MCP transport state in DO storage.
 */
const makeDbHandle = (options: {
  readonly idleTimeout: number;
  readonly maxLifetime: number;
}): DbHandle => {
  const connectionString = env.HYPERDRIVE?.connectionString ?? server.DATABASE_URL;
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: options.idleTimeout,
    max_lifetime: options.maxLifetime,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
  return {
    sql,
    db: drizzle(sql, { schema: combinedSchema }) as DrizzleDb,
    end: () => sql.end({ timeout: 0 }).catch(() => undefined),
  };
};

const makeLongLivedDb = (): DbHandle => makeDbHandle({ idleTimeout: 20, maxLifetime: 300 });

const makeRequestScopedDb = (): DbHandle => makeDbHandle({ idleTimeout: 0, maxLifetime: 60 });

const makeResolveOrganizationServices = (dbHandle: DbHandle) => {
  const DbLive = Layer.succeed(DbService, { sql: dbHandle.sql, db: dbHandle.db });
  const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
  return Layer.mergeAll(DbLive, UserStoreLive, CoreSharedServices);
};

// Session services DON'T re-provide `DoTelemetryLive` — that would install a
// second WebSdk tracer in the nested Effect scope, disconnecting every
// child span from the outer `McpSessionDO.init` / `McpSessionDO.handleRequest`
// trace. Tracer comes from the outermost `Effect.provide(DoTelemetryLive)`
// at the DO method boundary.
const makeSessionServices = (dbHandle: DbHandle) =>
  makeResolveOrganizationServices(dbHandle);

const resolveSessionMeta = Effect.fn("McpSessionDO.resolveSessionMeta")(function* (
  organizationId: string,
) {
    const org = yield* resolveOrganization(organizationId);
    if (!org) {
      return yield* new OrganizationNotFoundError({ organizationId });
    }
    return {
      organizationId: org.id,
      organizationName: org.name,
    } satisfies SessionMeta;
  });

const requestScopedRuntimeEnabled = server.MCP_SESSION_REQUEST_SCOPED_RUNTIME === "true";

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class McpSessionDO extends DurableObject {
  private mcpServer: McpServer | null = null;
  private transport: WorkerTransport | null = null;
  private initialized = false;
  private lastActivityMs = 0;
  private dbHandle: DbHandle | null = null;
  private sessionMeta: SessionMeta | null = null;
  // Updated at the start of each `handleRequest` so the host-mcp server's
  // `parentSpan` getter — invoked by the MCP SDK's deferred tool callbacks
  // after `transport.handleRequest()` has already returned its streaming
  // Response — can hand back the request-scoped span. The server is
  // session-scoped (a fresh server-per-request would lose the elicitation
  // request → reply correlation that the SDK keeps in-memory on the
  // `Server` instance), so we have to bridge a per-request value through
  // a per-session reference.
  private currentRequestSpan: Tracer.AnySpan | null = null;

  private makeStorage() {
    return {
      get: async (): Promise<TransportState | undefined> => {
        return await this.ctx.storage.get<TransportState>(TRANSPORT_STATE_KEY);
      },
      set: async (state: TransportState): Promise<void> => {
        await this.ctx.storage.put(TRANSPORT_STATE_KEY, state);
      },
    };
  }

  private loadSessionMeta(): Effect.Effect<SessionMeta | null> {
    return Effect.promise(async () => {
      if (this.sessionMeta) return this.sessionMeta;
      const stored = await this.ctx.storage.get<SessionMeta>(SESSION_META_KEY);
      this.sessionMeta = stored ?? null;
      return this.sessionMeta;
    }).pipe(Effect.withSpan("mcp.session.load_meta"));
  }

  private async saveSessionMeta(sessionMeta: SessionMeta): Promise<void> {
    this.sessionMeta = sessionMeta;
    await this.ctx.storage.put(SESSION_META_KEY, sessionMeta);
  }

  private clearSessionState(): Effect.Effect<void> {
    return Effect.promise(async () => {
      this.sessionMeta = null;
      this.initialized = false;
      this.lastActivityMs = 0;

      await Promise.all([
        this.ctx.storage.delete(TRANSPORT_STATE_KEY).catch(() => false),
        this.ctx.storage.delete(SESSION_META_KEY).catch(() => false),
      ]);
    }).pipe(Effect.withSpan("mcp.session.clear_state"));
  }

  private createConnectedRuntime(
    sessionMeta: SessionMeta,
    options: { readonly dbHandle: DbHandle; readonly enableJsonResponse?: boolean },
  ) {
    const self = this;
    return Effect.gen(function* () {
      // MCP sessions are per-org, not per-user (today the MCP client
      // init token only carries `organizationId`). Until we thread the
      // user through MCP's OAuth-init path, org is both the only scope
      // and the write target for this session.
      const { executor, engine } = yield* makeExecutionStack({
        organizationId: sessionMeta.organizationId,
        read: [
          {
            id: sessionMeta.organizationId,
            name: sessionMeta.organizationName,
          },
        ],
      });
      // Build the description here so the postgres query it runs
      // (`executor.sources.list`) lands as a child of
      // `McpSessionDO.createRuntime`. host-mcp would otherwise call
      // `Effect.runPromise(engine.getDescription)` at its async
      // MCP-SDK boundary and orphan the sub-span.
      const description = yield* buildExecuteDescription(executor);
      const mcpServer = yield* createExecutorMcpServer({
        engine,
        description,
        parentSpan: () => self.currentRequestSpan ?? undefined,
      }).pipe(Effect.withSpan("McpSessionDO.createExecutorMcpServer"));
      const transport = new WorkerTransport({
        sessionIdGenerator: () => self.ctx.id.toString(),
        storage: self.makeStorage(),
        enableJsonResponse: options.enableJsonResponse,
      });
      yield* Effect.promise(() => mcpServer.connect(transport)).pipe(
        Effect.withSpan("McpSessionDO.transport.connect"),
      );
      return { mcpServer, transport };
    }).pipe(
      Effect.withSpan("McpSessionDO.createRuntime"),
      Effect.provide(makeSessionServices(options.dbHandle)),
    );
  }

  private resolveAndStoreSessionMeta(token: McpSessionInit) {
    const self = this;
    return Effect.gen(function* () {
      const dbHandle = makeRequestScopedDb();
      try {
        const sessionMeta = yield* resolveSessionMeta(token.organizationId).pipe(
          Effect.provide(makeResolveOrganizationServices(dbHandle)),
        );
        yield* Effect.promise(() => self.saveSessionMeta(sessionMeta)).pipe(
          Effect.withSpan("mcp.session.save_meta"),
        );
        return sessionMeta;
      } finally {
        yield* Effect.promise(() => dbHandle.end());
      }
    }).pipe(Effect.withSpan("mcp.session.resolve_and_store_meta"));
  }

  async init(token: McpSessionInit, incoming?: IncomingTraceHeaders): Promise<void> {
    if (this.initialized) return;
    return Effect.runPromise(
      this.doInit(token).pipe(
        Effect.withSpan("McpSessionDO.init", {
          attributes: { "mcp.auth.organization_id": token.organizationId },
        }),
        (eff) => withIncomingParent(incoming, eff),
        Effect.provide(DoTelemetryLive),
      ),
    );
  }

  private doInit(token: McpSessionInit) {
    const self = this;
    // Single Effect chain so every sub-span (resolveSessionMeta,
    // createRuntime, createScopedExecutor, createExecutorMcpServer,
    // transport.connect, storage.setAlarm) lands as a child of
    // `McpSessionDO.init`. The prior implementation called
    // `Effect.runPromise` nested inside an async function, which orphaned
    // each sub-span into its own root trace and made init opaque —
    // dashboard saw one 2.77s span with nothing under it.
    return Effect.gen(function* () {
      const sessionMeta = yield* self.resolveAndStoreSessionMeta(token);

      if (!requestScopedRuntimeEnabled) {
        self.dbHandle = makeLongLivedDb();
        // POST responses go out as JSON so `transport.handleRequest()` awaits
        // every MCP tool callback before resolving — keeps engine spans inside
        // the outer `handleRequest` Effect's fiber so `currentRequestSpan` is
        // still set when the host-mcp `parentSpan` getter reads it. With SSE
        // POSTs the callback fires after `Effect.ensuring` clears the field
        // and engine spans orphan into new root traces. GET still streams
        // (the GET handler doesn't consult `enableJsonResponse`).
        const runtime = yield* self.createConnectedRuntime(sessionMeta, {
          dbHandle: self.dbHandle,
          enableJsonResponse: true,
        });
        self.mcpServer = runtime.mcpServer;
        self.transport = runtime.transport;
      }

      self.initialized = true;
      self.lastActivityMs = Date.now();

      yield* Effect.promise(() => self.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS)).pipe(
        Effect.withSpan("McpSessionDO.setAlarm"),
      );
    }).pipe(
      Effect.tapErrorCause((cause) =>
        Effect.sync(() => {
          console.error("[mcp-session] init failed:", cause);
        }),
      ),
      Effect.catchAllCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => self.cleanup());
          return yield* Effect.failCause(cause);
        }),
      ),
      Effect.orDie,
    );
  }

  private handleRequestWithRequestScopedRuntime(request: Request) {
    const self = this;
    return Effect.gen(function* () {
      const sessionMeta = yield* self.loadSessionMeta();
      if (!sessionMeta) {
        return jsonRpcError(404, -32001, "Session timed out due to inactivity — please reconnect");
      }

      self.initialized = true;
      self.lastActivityMs = Date.now();

      const dbHandle = makeRequestScopedDb();
      const cleanupDb = Effect.promise(() => dbHandle.end()).pipe(
        Effect.withSpan("mcp.session.db.close"),
      );
      return yield* Effect.acquireUseRelease(
        self.createConnectedRuntime(sessionMeta, {
          dbHandle,
          enableJsonResponse: request.method !== "GET",
        }),
        ({ transport }) =>
          Effect.gen(function* () {
            const response = yield* Effect.promise(() => transport.handleRequest(request)).pipe(
              Effect.withSpan("McpSessionDO.transport.handleRequest", {
                attributes: {
                  "mcp.request.method": request.method,
                  "mcp.request.content_type":
                    request.headers.get("content-type") ?? "",
                  "mcp.request.content_length":
                    request.headers.get("content-length") ?? "",
                },
              }),
            );
            yield* Effect.annotateCurrentSpan({
              "mcp.response.status_code": response.status,
            });
            if (request.method === "DELETE") {
              yield* self.clearSessionState();
            }
            return response;
          }),
        ({ mcpServer, transport }) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => transport.close().catch(() => undefined)).pipe(
              Effect.withSpan("mcp.session.transport.close"),
            );
            yield* Effect.promise(() => mcpServer.close().catch(() => undefined)).pipe(
              Effect.withSpan("mcp.session.server.close"),
            );
            yield* cleanupDb;
          }).pipe(Effect.withSpan("mcp.session.runtime.release")),
      );
    }).pipe(
      Effect.withSpan("mcp.session.request_scoped_runtime"),
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          console.error("[mcp-session] request-scoped handleRequest error:", cause);
          Sentry.captureException(cause);
          return jsonRpcError(500, -32603, "Internal error");
        }),
      ),
    );
  }

  async handleRequest(request: Request): Promise<Response> {
    // Wrap the dispatch in an Effect span so every DO request — not just
    // the rare new-session `init()` — shows up in Axiom. Basic attributes
    // only (method, session-id presence, response status); rich client
    // fingerprint stays on the edge `mcp.request` span, which shares a
    // trace_id with this one.
    const incoming = {
      traceparent: request.headers.get("traceparent") ?? undefined,
      tracestate: request.headers.get("tracestate") ?? undefined,
      baggage: request.headers.get("baggage") ?? undefined,
    } satisfies IncomingTraceHeaders;
    const self = this;
    const program = Effect.gen(function* () {
      // Capture the request-entry span so the host-mcp `parentSpan` getter
      // — fired by deferred MCP SDK callbacks after this Effect has already
      // returned — anchors engine spans under the same trace. Cleared in a
      // finalizer so a future request that arrives without a fresh span
      // doesn't accidentally inherit a stale one.
      const span = yield* Effect.currentSpan;
      self.currentRequestSpan = span;

      return yield* self.dispatchRequest(request).pipe(
        Effect.tap((response) =>
          Effect.annotateCurrentSpan({
            "mcp.response.status_code": response.status,
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            self.currentRequestSpan = null;
          }),
        ),
      );
    }).pipe(
      Effect.withSpan("McpSessionDO.handleRequest", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": !!request.headers.get("mcp-session-id"),
        },
      }),
      (eff) => withIncomingParent(incoming, eff),
      Effect.provide(DoTelemetryLive),
    );
    return Effect.runPromise(program);
  }

  private dispatchRequest(request: Request): Effect.Effect<Response> {
    if (requestScopedRuntimeEnabled) {
      return this.handleRequestWithRequestScopedRuntime(request);
    }

    if (!this.initialized || !this.transport) {
      return Effect.succeed(
        jsonRpcError(404, -32001, "Session timed out due to inactivity — please reconnect"),
      );
    }

    this.lastActivityMs = Date.now();
    const transport = this.transport;
    const self = this;
    return Effect.gen(function* () {
      const response = yield* Effect.promise(() => transport.handleRequest(request)).pipe(
        Effect.withSpan("McpSessionDO.transport.handleRequest", {
          attributes: {
            "mcp.request.method": request.method,
            "mcp.request.content_type":
              request.headers.get("content-type") ?? "",
            "mcp.request.content_length":
              request.headers.get("content-length") ?? "",
          },
        }),
      );
      yield* Effect.annotateCurrentSpan({
        "mcp.response.status_code": response.status,
      });
      if (request.method === "DELETE") {
        yield* Effect.promise(() => self.cleanup()).pipe(
          Effect.withSpan("mcp.session.cleanup"),
        );
      }
      return response;
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          console.error("[mcp-session] handleRequest error:", cause);
          Sentry.captureException(cause);
          return jsonRpcError(500, -32603, "Internal error");
        }),
      ),
    );
  }

  async alarm(): Promise<void> {
    const program = Effect.promise(() => this.runAlarm()).pipe(
      Effect.withSpan("McpSessionDO.alarm"),
      Effect.provide(DoTelemetryLive),
    );
    return Effect.runPromise(program);
  }

  private async runAlarm(): Promise<void> {
    const idleMs = Date.now() - this.lastActivityMs;
    if (idleMs >= SESSION_TIMEOUT_MS) {
      await this.cleanup();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  private async cleanup(): Promise<void> {
    if (this.transport) {
      await this.transport.close().catch(() => undefined);
      this.transport = null;
    }
    if (this.mcpServer) {
      await this.mcpServer.close().catch(() => undefined);
      this.mcpServer = null;
    }
    if (this.dbHandle) {
      await this.dbHandle.end();
      this.dbHandle = null;
    }
    await Effect.runPromise(this.clearSessionState());
  }
}
