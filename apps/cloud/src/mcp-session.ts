// ---------------------------------------------------------------------------
// MCP Session Durable Object — holds MCP server + engine per session
// ---------------------------------------------------------------------------

import { DurableObject, env } from "cloudflare:workers";
import { Data, Effect, Layer } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkerTransport, type TransportState } from "agents/mcp";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createExecutorMcpServer } from "@executor/host-mcp";
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

const makeSessionServices = (dbHandle: DbHandle) =>
  Layer.mergeAll(makeResolveOrganizationServices(dbHandle), DoTelemetryLive);

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

  private async loadSessionMeta(): Promise<SessionMeta | null> {
    if (this.sessionMeta) return this.sessionMeta;
    const stored = await this.ctx.storage.get<SessionMeta>(SESSION_META_KEY);
    this.sessionMeta = stored ?? null;
    return this.sessionMeta;
  }

  private async saveSessionMeta(sessionMeta: SessionMeta): Promise<void> {
    this.sessionMeta = sessionMeta;
    await this.ctx.storage.put(SESSION_META_KEY, sessionMeta);
  }

  private async clearSessionState(): Promise<void> {
    this.sessionMeta = null;
    this.initialized = false;
    this.lastActivityMs = 0;

    await Promise.all([
      this.ctx.storage.delete(TRANSPORT_STATE_KEY).catch(() => false),
      this.ctx.storage.delete(SESSION_META_KEY).catch(() => false),
    ]);
  }

  private async createConnectedRuntime(
    sessionMeta: SessionMeta,
    options: {
      readonly dbHandle: DbHandle;
      readonly enableJsonResponse?: boolean;
    },
  ): Promise<{ mcpServer: McpServer; transport: WorkerTransport }> {
    const program = Effect.gen(function* () {
      const { engine } = yield* makeExecutionStack(
        sessionMeta.organizationId,
        sessionMeta.organizationName,
      );
      return yield* Effect.promise(() => createExecutorMcpServer({ engine }));
    }).pipe(Effect.withSpan("McpSessionDO.createRuntime"), Effect.provide(makeSessionServices(options.dbHandle)));

    const mcpServer = await Effect.runPromise(program);
    const transport = new WorkerTransport({
      sessionIdGenerator: () => this.ctx.id.toString(),
      storage: this.makeStorage(),
      enableJsonResponse: options.enableJsonResponse,
    });

    await mcpServer.connect(transport);
    return { mcpServer, transport };
  }

  private async resolveAndStoreSessionMeta(token: McpSessionInit): Promise<SessionMeta> {
    const dbHandle = makeRequestScopedDb();
    try {
      const sessionMeta = await Effect.runPromise(
        resolveSessionMeta(token.organizationId).pipe(
          Effect.provide(makeResolveOrganizationServices(dbHandle)),
        ),
      );
      await this.saveSessionMeta(sessionMeta);
      return sessionMeta;
    } finally {
      await dbHandle.end();
    }
  }

  async init(token: McpSessionInit): Promise<void> {
    if (this.initialized) return;

    try {
      const sessionMeta = await this.resolveAndStoreSessionMeta(token);

      if (!requestScopedRuntimeEnabled) {
        this.dbHandle = makeLongLivedDb();
        const runtime = await this.createConnectedRuntime(sessionMeta, {
          dbHandle: this.dbHandle,
        });
        this.mcpServer = runtime.mcpServer;
        this.transport = runtime.transport;
      }

      this.initialized = true;
      this.lastActivityMs = Date.now();

      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    } catch (err) {
      // Partial init leaves dangling resources (DB socket, maybe mcpServer).
      // Clean up before rethrowing so the DO isn't stuck in a half-built state.
      console.error("[mcp-session] init failed:", err instanceof Error ? err.stack : err);
      await this.cleanup();
      throw err;
    }
  }

  private async handleRequestWithRequestScopedRuntime(request: Request): Promise<Response> {
    const sessionMeta = await this.loadSessionMeta();
    if (!sessionMeta) {
      return jsonRpcError(404, -32001, "Session timed out due to inactivity — please reconnect");
    }

    this.initialized = true;
    this.lastActivityMs = Date.now();

    let dbHandle: DbHandle | null = null;
    let mcpServer: McpServer | null = null;
    let transport: WorkerTransport | null = null;

    try {
      dbHandle = makeRequestScopedDb();
      const runtime = await this.createConnectedRuntime(sessionMeta, {
        dbHandle,
        enableJsonResponse: request.method !== "GET",
      });
      mcpServer = runtime.mcpServer;
      transport = runtime.transport;

      const response = await transport.handleRequest(request);
      if (request.method === "DELETE") {
        await this.clearSessionState();
      }
      return response;
    } catch (err) {
      console.error(
        "[mcp-session] request-scoped handleRequest error:",
        err instanceof Error ? err.stack : err,
      );
      return jsonRpcError(500, -32603, "Internal error");
    } finally {
      await transport?.close().catch(() => undefined);
      await mcpServer?.close().catch(() => undefined);
      await dbHandle?.end();
    }
  }

  async handleRequest(request: Request): Promise<Response> {
    if (requestScopedRuntimeEnabled) {
      return this.handleRequestWithRequestScopedRuntime(request);
    }

    if (!this.initialized || !this.transport) {
      return jsonRpcError(404, -32001, "Session timed out due to inactivity — please reconnect");
    }

    this.lastActivityMs = Date.now();

    try {
      const response = await this.transport.handleRequest(request);
      if (request.method === "DELETE") {
        await this.cleanup();
      }
      return response;
    } catch (err) {
      console.error("[mcp-session] handleRequest error:", err instanceof Error ? err.stack : err);
      return jsonRpcError(500, -32603, "Internal error");
    }
  }

  async alarm(): Promise<void> {
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
    await this.clearSessionState();
  }
}
