// ---------------------------------------------------------------------------
// MCP Session Durable Object — holds MCP server + engine per session
// ---------------------------------------------------------------------------

import * as Cloudflare from "alchemy/Cloudflare/Workers/Runtime";
import { Cause, Data, Effect, Layer } from "effect";
import * as Tracer from "effect/Tracer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createExecutorMcpServer } from "@executor-js/host-mcp";
import { buildExecuteDescription } from "@executor-js/execution";
import type { DrizzleDb, DbServiceShape } from "./services/db";

// Import directly from core-shared-services, NOT from ./api/layers.ts.
// The full layers module pulls in `auth/handlers.ts` → `@tanstack/react-start/server`,
// which uses a `#tanstack-start-entry` subpath specifier that breaks module
// load under vitest-pool-workers. The DO only needs the core two services
// (WorkOSAuth + AutumnService), so we import them from the tight module.
import { CoreSharedServices } from "./api/core-shared-services";
import { UserStoreService } from "./auth/context";
import { resolveOrganization } from "./auth/resolve-organization";
import { DbService, combinedSchema, resolveConnectionString } from "./services/db";
import { makeExecutionStack } from "./services/execution-stack";
import {
  makeMcpWorkerTransport,
  type McpTransportState,
  type McpWorkerTransport,
} from "./services/mcp-worker-transport";
import { DoTelemetryLive } from "./services/telemetry";
import { captureCause } from "./observability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpSessionInit = {
  organizationId: string;
  userId: string;
};

export type IncomingTraceHeaders = {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
};

export type McpSessionShape = {
  readonly init: (
    token: McpSessionInit,
    incoming?: IncomingTraceHeaders,
  ) => Effect.Effect<void, unknown>;
  readonly handleRequest: (request: Request) => Effect.Effect<Response, unknown>;
  readonly clearSession: (incoming?: IncomingTraceHeaders) => Effect.Effect<void, unknown>;
  readonly alarm: () => Effect.Effect<void, unknown>;
};

const HEARTBEAT_MS = 30 * 1000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const LONG_LIVED_DB_IDLE_TIMEOUT_SECONDS = 5;
const LONG_LIVED_DB_MAX_LIFETIME_SECONDS = 120;
const TRANSPORT_STATE_KEY = "transport";
const SESSION_META_KEY = "session-meta";
const LAST_ACTIVITY_KEY = "last-activity-ms";
const INTERNAL_ACCOUNT_ID_HEADER = "x-executor-mcp-account-id";
const INTERNAL_ORGANIZATION_ID_HEADER = "x-executor-mcp-organization-id";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class OrganizationNotFoundError extends Data.TaggedError("OrganizationNotFoundError")<{
  readonly organizationId: string;
}> {}

class McpServerCloseError extends Data.TaggedError("McpServerCloseError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });

const sessionOwnerMismatch = () =>
  jsonRpcError(403, -32003, "MCP session does not belong to the current bearer");

// W3C propagation across the worker -> DO boundary. mcp.ts injects the
// worker's `traceparent` and forwards incoming trace headers on forwarded
// requests. We convert the parent span into Effect's native ExternalSpan so
// the DO's root span stays in the same logical trace without the OpenTelemetry
// SDK bridge.
const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const parseTraceparent = (traceparent: string | null | undefined): Tracer.ExternalSpan | null => {
  const value = traceparent;
  if (!value) return null;
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match) return null;
  return Tracer.externalSpan({
    traceId: match[2]!,
    spanId: match[3]!,
    sampled: (parseInt(match[4]!, 16) & 1) === 1,
  });
};

const withIncomingParent = <A, E, R>(
  incoming: IncomingTraceHeaders | null | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const parsed = parseTraceparent(incoming?.traceparent);
  return parsed ? Effect.withParentSpan(effect, parsed) : effect;
};

type DbHandle = DbServiceShape & { end: () => Promise<void> };
type SessionMeta = {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly userId: string;
};

/**
 * Base DB handle factory for MCP session runtimes.
 *
 * The DO keeps one postgres.js client for the MCP session runtime. postgres.js
 * closes idle sockets quickly, while the runtime object stays alive so the MCP
 * server can preserve session-local protocol state across requests.
 */
const makeDbHandle = (options: {
  readonly idleTimeout: number;
  readonly maxLifetime: number;
  readonly env: Env;
}): DbHandle => {
  const connectionString = resolveConnectionString(options.env);
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: options.idleTimeout,
    max_lifetime: options.maxLifetime,
    connect_timeout: 10,
    fetch_types: false,
    prepare: true,
    onnotice: () => undefined,
  });
  return {
    sql,
    db: drizzle(sql, { schema: combinedSchema }) as DrizzleDb,
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: postgres.js close is best-effort during DO/runtime cleanup
    end: () => sql.end({ timeout: 0 }).catch(() => undefined),
  };
};

const makeLongLivedDb = (workerEnv: Env): DbHandle =>
  makeDbHandle({
    idleTimeout: LONG_LIVED_DB_IDLE_TIMEOUT_SECONDS,
    maxLifetime: LONG_LIVED_DB_MAX_LIFETIME_SECONDS,
    env: workerEnv,
  });

const makeEphemeralDb = (workerEnv: Env): DbHandle =>
  makeDbHandle({ idleTimeout: 0, maxLifetime: 60, env: workerEnv });

const makeResolveOrganizationServices = (dbHandle: DbHandle) => {
  const DbLive = Layer.succeed(DbService)({ sql: dbHandle.sql, db: dbHandle.db });
  const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
  return Layer.mergeAll(DbLive, UserStoreLive, CoreSharedServices);
};

// Session services DON'T re-provide `DoTelemetryLive` — that would install a
// second WebSdk tracer in the nested Effect scope, disconnecting every
// child span from the outer `McpSessionDO.init` / `McpSessionDO.handleRequest`
// trace. Tracer comes from the outermost `Effect.provide(DoTelemetryLive)`
// at the DO method boundary.
const makeSessionServices = (dbHandle: DbHandle) => makeResolveOrganizationServices(dbHandle);

const resolveSessionMeta = Effect.fn("McpSessionDO.resolveSessionMeta")(function* (
  organizationId: string,
  userId: string,
) {
  const org = yield* resolveOrganization(organizationId);
  if (!org) {
    return yield* new OrganizationNotFoundError({ organizationId });
  }
  return {
    organizationId: org.id,
    organizationName: org.name,
    userId,
  } satisfies SessionMeta;
});

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

type AlchemyDurableObjectState = Cloudflare.DurableObjectState["Service"];

const makeMcpSession = (state: AlchemyDurableObjectState, workerEnv: Env): McpSessionShape => {
  const instanceCreatedAt = Date.now();
  let mcpServer: McpServer | null = null;
  let transport: McpWorkerTransport | null = null;
  let initialized = false;
  let lastActivityMs = 0;
  let dbHandle: DbHandle | null = null;
  let sessionMeta: SessionMeta | null = null;
  let transportJsonResponseMode: boolean | null = null;
  // Updated at the start of each handleRequest so the host-mcp server's
  // parentSpan getter can anchor deferred MCP SDK callbacks to the request span.
  let currentRequestSpan: Tracer.AnySpan | null = null;

  const provideDoTelemetry = <A, E>(effect: Effect.Effect<A, E, Cloudflare.WorkerEnvironment>) =>
    effect.pipe(
      Effect.provide(DoTelemetryLive),
      Effect.provideService(Cloudflare.WorkerEnvironment, workerEnv),
    );

  const makeStorage = () => ({
    get: (): Effect.Effect<McpTransportState | undefined, unknown> =>
      state.storage.get<McpTransportState>(TRANSPORT_STATE_KEY),
    set: (value: McpTransportState): Effect.Effect<void, unknown> =>
      state.storage.put(TRANSPORT_STATE_KEY, value),
  });

  const loadSessionMeta = (): Effect.Effect<SessionMeta | null, unknown> =>
    Effect.gen(function* () {
      if (sessionMeta) return sessionMeta;
      const stored = yield* state.storage.get<SessionMeta>(SESSION_META_KEY);
      sessionMeta = stored ?? null;
      return sessionMeta;
    }).pipe(Effect.withSpan("mcp.session.load_meta"));

  const saveSessionMeta = (next: SessionMeta): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      sessionMeta = next;
      yield* state.storage.put(SESSION_META_KEY, next);
    });

  const markActivity = (now = Date.now()): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      lastActivityMs = now;
      yield* Effect.all(
        [state.storage.put(LAST_ACTIVITY_KEY, now), state.storage.setAlarm(now + HEARTBEAT_MS)],
        { concurrency: "unbounded" },
      );
    });

  const loadLastActivity = (): Effect.Effect<number, unknown> =>
    Effect.gen(function* () {
      if (lastActivityMs > 0) return lastActivityMs;
      const stored = yield* state.storage.get<number>(LAST_ACTIVITY_KEY);
      lastActivityMs = stored ?? 0;
      return lastActivityMs;
    });

  const entryAttrs = (methodEnteredAt: number): Record<string, unknown> => {
    const now = Date.now();
    return {
      "mcp.do.instance_age_ms": now - instanceCreatedAt,
      "mcp.do.method_entry_delay_ms": now - methodEnteredAt,
      "mcp.session.session_id": state.id.toString(),
      "mcp.session.initialized": initialized,
      "mcp.session.has_transport": !!transport,
      "mcp.session.has_meta_memory": !!sessionMeta,
    };
  };

  const clearSessionState = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      sessionMeta = null;
      initialized = false;
      lastActivityMs = 0;
      transportJsonResponseMode = null;

      yield* Effect.all(
        [
          state.storage.delete(TRANSPORT_STATE_KEY).pipe(Effect.asVoid),
          state.storage.delete(SESSION_META_KEY).pipe(Effect.asVoid),
          state.storage.delete(LAST_ACTIVITY_KEY).pipe(Effect.asVoid),
          state.storage.deleteAlarm(),
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.withSpan("mcp.session.clear_state"));

  const createConnectedRuntime = (
    meta: SessionMeta,
    options: { readonly dbHandle: DbHandle; readonly enableJsonResponse?: boolean },
  ) =>
    Effect.gen(function* () {
      const { executor, engine } = yield* makeExecutionStack(
        meta.userId,
        meta.organizationId,
        meta.organizationName,
      );
      const description = yield* buildExecuteDescription(executor);
      const server = yield* createExecutorMcpServer({
        engine,
        description,
        parentSpan: () => currentRequestSpan ?? undefined,
        debug: workerEnv.EXECUTOR_MCP_DEBUG === "true",
      }).pipe(Effect.withSpan("McpSessionDO.createExecutorMcpServer"));
      const nextTransport = yield* makeMcpWorkerTransport({
        sessionIdGenerator: () => state.id.toString(),
        storage: makeStorage(),
        enableJsonResponse: options.enableJsonResponse,
      });
      transportJsonResponseMode = options.enableJsonResponse ?? false;
      yield* nextTransport.connect(server);
      return { mcpServer: server, transport: nextTransport };
    }).pipe(
      Effect.withSpan("McpSessionDO.createRuntime"),
      Effect.provide(makeSessionServices(options.dbHandle)),
    );

  const closeRuntime = (): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (transport) {
        yield* transport.close();
        transport = null;
      }
      if (mcpServer) {
        const server = mcpServer;
        yield* Effect.ignore(
          Effect.tryPromise({
            try: () => server.close(),
            catch: (cause) => new McpServerCloseError({ cause }),
          }),
        );
        mcpServer = null;
      }
      if (dbHandle) {
        const handle = dbHandle;
        yield* Effect.promise(() => handle.end());
        dbHandle = null;
      }
      initialized = false;
      transportJsonResponseMode = null;
    });

  const installRuntime = (
    meta: SessionMeta,
    options: { readonly dbHandle: DbHandle; readonly enableJsonResponse: boolean },
  ) =>
    Effect.gen(function* () {
      const runtime = yield* createConnectedRuntime(meta, options);
      dbHandle = options.dbHandle;
      mcpServer = runtime.mcpServer;
      transport = runtime.transport;
      initialized = true;
    });

  const restoreRuntimeFromStorage = (
    request: Request,
  ): Effect.Effect<"restored" | "missing_meta", unknown, Cloudflare.WorkerEnvironment> =>
    Effect.gen(function* () {
      if (initialized && transport) return "restored" as const;

      const meta = yield* loadSessionMeta();
      if (!meta) {
        yield* Effect.annotateCurrentSpan({ "mcp.session.restore.outcome": "missing_meta" });
        return "missing_meta" as const;
      }

      yield* closeRuntime();
      const nextDbHandle = makeLongLivedDb(workerEnv);
      yield* installRuntime(meta, { dbHandle: nextDbHandle, enableJsonResponse: true });
      yield* markActivity().pipe(Effect.withSpan("McpSessionDO.markActivity"));
      yield* Effect.annotateCurrentSpan({ "mcp.session.restore.outcome": "restored" });
      return "restored" as const;
    }).pipe(
      Effect.withSpan("McpSessionDO.restoreRuntime", {
        attributes: {
          "mcp.request.method": request.method,
          "mcp.request.session_id_present": !!request.headers.get("mcp-session-id"),
        },
      }),
    );

  const ensureJsonResponseTransportForPost = (
    request: Request,
  ): Effect.Effect<void, unknown, Cloudflare.WorkerEnvironment> =>
    Effect.gen(function* () {
      if (request.method !== "POST" || transportJsonResponseMode === true) return;

      const meta = yield* loadSessionMeta();
      if (!meta) return;

      yield* closeRuntime();
      const nextDbHandle = makeLongLivedDb(workerEnv);
      yield* installRuntime(meta, { dbHandle: nextDbHandle, enableJsonResponse: true });
      yield* Effect.annotateCurrentSpan({ "mcp.session.transport_upgraded_json_response": true });
    }).pipe(Effect.withSpan("McpSessionDO.ensureJsonResponseTransportForPost"));

  const validateSessionOwner = (request: Request): Effect.Effect<Response | null, unknown> =>
    Effect.gen(function* () {
      const meta = yield* loadSessionMeta();
      if (!meta) return null;

      const accountId = request.headers.get(INTERNAL_ACCOUNT_ID_HEADER);
      const organizationId = request.headers.get(INTERNAL_ORGANIZATION_ID_HEADER);
      const matches = accountId === meta.userId && organizationId === meta.organizationId;
      yield* Effect.annotateCurrentSpan({ "mcp.session.owner_match": matches });
      return matches ? null : sessionOwnerMismatch();
    }).pipe(Effect.withSpan("mcp.session.validate_owner"));

  const resolveAndStoreSessionMeta = Effect.fn("mcp.session.resolve_and_store_meta")(function* (
    token: McpSessionInit,
  ) {
    const handle = makeEphemeralDb(workerEnv);
    return yield* resolveSessionMeta(token.organizationId, token.userId).pipe(
      Effect.provide(makeResolveOrganizationServices(handle)),
      Effect.tap((meta) => saveSessionMeta(meta).pipe(Effect.withSpan("mcp.session.save_meta"))),
      Effect.ensuring(Effect.promise(() => handle.end())),
    );
  });

  const cleanup = (): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      yield* closeRuntime();
      yield* clearSessionState();
    });

  const doInit = (token: McpSessionInit) =>
    Effect.gen(function* () {
      const meta = yield* resolveAndStoreSessionMeta(token);
      const handle = makeLongLivedDb(workerEnv);
      const runtime = yield* createConnectedRuntime(meta, {
        dbHandle: handle,
        enableJsonResponse: true,
      });
      dbHandle = handle;
      mcpServer = runtime.mcpServer;
      transport = runtime.transport;
      initialized = true;
      yield* markActivity().pipe(Effect.withSpan("McpSessionDO.markActivity"));
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => {
          console.error("[mcp-session] init failed:", cause);
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* cleanup();
          return yield* Effect.failCause(cause);
        }),
      ),
    );

  const init = (token: McpSessionInit, incoming?: IncomingTraceHeaders) => {
    const methodEnteredAt = Date.now();
    if (initialized) return Effect.void;
    return Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan(entryAttrs(methodEnteredAt));
      yield* doInit(token);
    }).pipe(
      Effect.withSpan("McpSessionDO.init", {
        attributes: { "mcp.auth.organization_id": token.organizationId },
      }),
      (eff) => withIncomingParent(incoming, eff),
      provideDoTelemetry,
    );
  };

  const dispatchAuthorizedRequest = (
    request: Request,
  ): Effect.Effect<Response, unknown, Cloudflare.WorkerEnvironment> => {
    if (!initialized || !transport) {
      if (request.method === "DELETE") {
        return clearSessionState().pipe(
          Effect.as(new Response(null, { status: 204 })),
          Effect.withSpan("mcp.session.stale_delete"),
        );
      }
      return Effect.gen(function* () {
        const restored = yield* restoreRuntimeFromStorage(request);
        if (restored === "restored") return yield* dispatchAuthorizedRequest(request);
        return jsonRpcError(404, -32001, "Session timed out due to inactivity — please reconnect");
      });
    }

    return Effect.gen(function* () {
      yield* ensureJsonResponseTransportForPost(request);
      const activeTransport = transport;
      if (!activeTransport) {
        return jsonRpcError(404, -32001, "Session timed out due to inactivity — please reconnect");
      }

      yield* markActivity().pipe(Effect.withSpan("McpSessionDO.markActivity"));
      const response = yield* activeTransport.handleRequest(request).pipe(
        Effect.withSpan("McpSessionDO.transport.handleRequest", {
          attributes: {
            "mcp.request.method": request.method,
            "mcp.request.content_type": request.headers.get("content-type") ?? "",
            "mcp.request.content_length": request.headers.get("content-length") ?? "",
          },
        }),
      );
      yield* Effect.annotateCurrentSpan({
        "mcp.response.status_code": response.status,
        "mcp.response.content_type": response.headers.get("content-type") ?? "",
        "mcp.transport.enable_json_response": transportJsonResponseMode ?? false,
      });
      if (request.method === "DELETE") {
        yield* cleanup().pipe(Effect.withSpan("mcp.session.cleanup"));
      }
      return response;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error("[mcp-session] handleRequest error:", Cause.pretty(cause));
          captureCause(cause);
          return jsonRpcError(500, -32603, "Internal error");
        }),
      ),
    );
  };

  const dispatchRequest = (
    request: Request,
  ): Effect.Effect<Response, unknown, Cloudflare.WorkerEnvironment> =>
    Effect.gen(function* () {
      const ownerError = yield* validateSessionOwner(request);
      if (ownerError) return ownerError;
      return yield* dispatchAuthorizedRequest(request);
    });

  const handleRequest = (request: Request): Effect.Effect<Response, unknown> => {
    const methodEnteredAt = Date.now();
    const incoming = {
      traceparent: request.headers.get("traceparent") ?? undefined,
      tracestate: request.headers.get("tracestate") ?? undefined,
      baggage: request.headers.get("baggage") ?? undefined,
    } satisfies IncomingTraceHeaders;

    return Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan(entryAttrs(methodEnteredAt));
      const span = yield* Effect.currentSpan.pipe(Effect.catch(() => Effect.succeed(null)));
      currentRequestSpan = span;

      return yield* dispatchRequest(request).pipe(
        Effect.tap((response) =>
          Effect.annotateCurrentSpan({
            "mcp.response.status_code": response.status,
            "mcp.response.content_type": response.headers.get("content-type") ?? "",
            "mcp.transport.enable_json_response": transportJsonResponseMode ?? false,
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            currentRequestSpan = null;
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
      provideDoTelemetry,
    );
  };

  const runAlarm = (): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const lastActivity = yield* loadLastActivity();
      const idleMs = Date.now() - lastActivity;
      if (idleMs >= SESSION_TIMEOUT_MS) {
        yield* cleanup();
        return;
      }
      yield* state.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    });

  const alarm = (): Effect.Effect<void, unknown> =>
    runAlarm().pipe(Effect.withSpan("McpSessionDO.alarm"), provideDoTelemetry);

  const clearSession = (incoming?: IncomingTraceHeaders): Effect.Effect<void, unknown> =>
    cleanup().pipe(
      Effect.withSpan("McpSessionDO.clearSession"),
      (eff) => withIncomingParent(incoming, eff),
      provideDoTelemetry,
    );

  return { init, handleRequest, clearSession, alarm };
};

export class McpSessionDO extends Cloudflare.DurableObjectNamespace<McpSessionShape>()(
  "MCP_SESSION",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const workerEnv = yield* Cloudflare.WorkerEnvironment.typed<Env>();
      const state = yield* Cloudflare.DurableObjectState.asEffect();
      return makeMcpSession(state, workerEnv);
    });
  }),
) {}

export default McpSessionDO;
