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
import { createExecutionEngine } from "@executor/execution";
import { makeDynamicWorkerExecutor } from "@executor/runtime-dynamic-worker";
import type { DrizzleDb, DbServiceShape } from "./services/db";

import { makeTrackExecutionUsage } from "./api/autumn";
import { withExecutionUsageTracking } from "./api/execution-usage";
import { UserStoreService } from "./auth/context";
import { resolveOrganization } from "./auth/resolve-organization";
import { WorkOSAuth } from "./auth/workos";
import { server } from "./env";
import { AutumnService } from "./services/autumn";
import { createOrgExecutor } from "./services/executor";
import { DbService } from "./services/db";
import * as cloudSchema from "./services/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpSessionInit = {
  organizationId: string;
};

const HEARTBEAT_MS = 30 * 1000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

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

const combinedSchema = { ...cloudSchema };

type DbHandle = DbServiceShape & { end: () => Promise<void> };

/**
 * Create a long-lived DB connection for the DO lifetime.
 *
 * Unlike the per-request `DbService.Live` used in `api.ts`, this connection
 * stays open across requests within the DO. DOs have a single-threaded
 * execution model — there's no cross-request socket reuse issue because
 * only one request runs at a time. The connection is closed when the DO
 * cleans up (timeout or eviction).
 */
const makeLongLivedDb = (): DbHandle => {
  const connectionString = env.HYPERDRIVE?.connectionString ?? server.DATABASE_URL;
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 20,
    max_lifetime: 300,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
  return {
    sql,
    db: drizzle(sql, { schema: combinedSchema }) as DrizzleDb,
    end: () => sql.end({ timeout: 0 }).catch(() => undefined),
  };
};

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class McpSessionDO extends DurableObject {
  private mcpServer: McpServer | null = null;
  private transport: WorkerTransport | null = null;
  private initialized = false;
  private lastActivityMs = 0;
  private dbHandle: DbHandle | null = null;

  private makeStorage() {
    return {
      get: async (): Promise<TransportState | undefined> => {
        return await this.ctx.storage.get<TransportState>("transport");
      },
      set: async (state: TransportState): Promise<void> => {
        await this.ctx.storage.put("transport", state);
      },
    };
  }

  async init(token: McpSessionInit): Promise<void> {
    if (this.initialized) return;

    // Create a long-lived DB connection for the DO's lifetime
    this.dbHandle = makeLongLivedDb();

    const { sql, db } = this.dbHandle;
    const DbLive = Layer.succeed(DbService, { sql, db });
    const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
    const Services = Layer.mergeAll(
      DbLive,
      UserStoreLive,
      WorkOSAuth.Default,
      AutumnService.Default,
    );

    const program = Effect.gen(function* () {
      const org = yield* resolveOrganization(token.organizationId);
      if (!org)
        return yield* new OrganizationNotFoundError({ organizationId: token.organizationId });

      const executor = yield* createOrgExecutor(org.id, org.name);
      const codeExecutor = makeDynamicWorkerExecutor({ loader: env.LOADER });
      const autumn = yield* AutumnService;
      const engine = withExecutionUsageTracking(
        org.id,
        createExecutionEngine({ executor, codeExecutor }),
        makeTrackExecutionUsage(autumn),
      );
      return yield* Effect.promise(() => createExecutorMcpServer({ engine }));
    }).pipe(Effect.provide(Services));

    this.mcpServer = await Effect.runPromise(program);

    this.transport = new WorkerTransport({
      sessionIdGenerator: () => this.ctx.id.toString(),
      storage: this.makeStorage(),
    });

    await this.mcpServer.connect(this.transport);
    this.initialized = true;
    this.lastActivityMs = Date.now();

    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  async handleRequest(request: Request): Promise<Response> {
    if (!this.initialized || !this.transport) {
      return jsonRpcError(404, -32001, "Session timed out due to inactivity — please reconnect");
    }

    this.lastActivityMs = Date.now();

    try {
      return await this.transport.handleRequest(request);
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
    this.initialized = false;
  }
}
