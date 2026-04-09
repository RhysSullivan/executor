// ---------------------------------------------------------------------------
// MCP Session Durable Object — holds MCP server + engine per session
// ---------------------------------------------------------------------------

import { DurableObject, env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createExecutorMcpServer } from "@executor/host-mcp";
import { makeDynamicWorkerExecutor } from "@executor/runtime-dynamic-worker";
import type { DrizzleDb } from "@executor/storage-postgres";
import * as sharedSchema from "@executor/storage-postgres/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { UserStoreService } from "./auth/context";
import { server } from "./env";
import { createTeamExecutor } from "./services/executor";
import { DbService } from "./services/db";
import * as cloudSchema from "./services/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpSessionInit = {
  userId: string;
};

// Heartbeat interval — keeps the DO alive by re-scheduling an alarm before
// Cloudflare's ~60s idle eviction kicks in.
const HEARTBEAT_MS = 30 * 1000;

// Session timeout — clean up after no requests for this long.
// TODO: Make tier-based — free users get 60s, paid users get 5 minutes.
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Team resolution — user/team must already exist (created at signup)
// ---------------------------------------------------------------------------

const resolveTeam = (userId: string) =>
  Effect.gen(function* () {
    const users = yield* UserStoreService;
    const teams = yield* users.use((store) => store.getTeamsForUser(userId));

    if (teams.length === 0) {
      return yield* Effect.fail(new Error("No team found for user — account may not be set up"));
    }

    return { teamId: teams[0]!.teamId, teamName: teams[0]!.teamName ?? "Team" };
  });

// ---------------------------------------------------------------------------
// DB connection (non-scoped, lives for the DO lifetime)
// ---------------------------------------------------------------------------

const connectDb = async (): Promise<DrizzleDb> => {
  const connectionString =
    env.HYPERDRIVE?.connectionString ?? server.DATABASE_URL;
  const client = new Client({ connectionString });
  await client.connect();
  return drizzle(client, {
    schema: { ...sharedSchema, ...cloudSchema },
  }) as DrizzleDb;
};

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class McpSessionDO extends DurableObject {
  private mcpServer: McpServer | null = null;
  private transport: WebStandardStreamableHTTPServerTransport | null = null;
  private initialized = false;
  private lastActivityMs = 0;

  /**
   * Initialize the MCP session — resolves team, creates executor + engine + server.
   * The DB connection lives for the DO lifetime (Hyperdrive manages pooling).
   */
  async init(token: McpSessionInit): Promise<void> {
    if (this.initialized) return;

    const db = await connectDb();
    const DbLive = Layer.succeed(DbService, db);
    const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
    const Services = Layer.mergeAll(DbLive, UserStoreLive);

    const { teamId, teamName } = await Effect.runPromise(
      resolveTeam(token.userId).pipe(Effect.provide(Services)),
    );

    const executor = await Effect.runPromise(
      createTeamExecutor(teamId, teamName, server.ENCRYPTION_KEY).pipe(
        Effect.provide(DbLive),
      ),
    );

    const codeExecutor = makeDynamicWorkerExecutor({ loader: env.LOADER });

    this.mcpServer = await createExecutorMcpServer({ executor, codeExecutor });

    this.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => this.ctx.id.toString(),
    });

    await this.mcpServer.connect(this.transport);
    this.initialized = true;
    this.lastActivityMs = Date.now();

    // Start heartbeat — keeps DO alive until session times out
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  /**
   * Handle an MCP request. The transport manages the full MCP protocol.
   */
  async handleRequest(request: Request): Promise<Response> {
    if (!this.initialized || !this.transport) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Session timed out due to inactivity — please reconnect",
          },
          id: null,
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    this.lastActivityMs = Date.now();

    try {
      return await this.transport.handleRequest(request);
    } catch (err) {
      console.error(
        "[mcp-session] handleRequest error:",
        err instanceof Error ? err.stack : err,
      );
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : "Internal error",
          },
          id: null,
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  async alarm(): Promise<void> {
    const idleMs = Date.now() - this.lastActivityMs;
    if (idleMs >= SESSION_TIMEOUT_MS) {
      await this.cleanup();
      return;
    }
    // Still active — schedule next heartbeat
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
    this.initialized = false;
  }
}
