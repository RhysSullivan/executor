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

import { UserStoreService } from "./auth/context";
import { server } from "./env";
import { createTeamExecutor } from "./services/executor";
import { DbService } from "./services/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpSessionInit = {
  userId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
};

// Alarm fires after 10 minutes of inactivity to clean up the DO.
const SESSION_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Team resolution
// ---------------------------------------------------------------------------

const resolveTeam = (token: McpSessionInit) =>
  Effect.gen(function* () {
    const users = yield* UserStoreService;
    const teams = yield* users.use((store) => store.getTeamsForUser(token.userId));

    if (teams.length > 0) {
      return { teamId: teams[0]!.teamId, teamName: teams[0]!.teamName ?? "Team" };
    }

    const name =
      [token.firstName, token.lastName].filter(Boolean).join(" ") || undefined;
    const user = yield* users.use((store) =>
      store.upsertUser({
        id: token.userId,
        email: token.email ?? "unknown@executor.sh",
        name,
      }),
    );
    const team = yield* users.use((store) =>
      store.createTeam(`${user.name ?? user.email}'s Team`),
    );
    yield* users.use((store) => store.addMember(team.id, user.id, "owner"));
    return { teamId: team.id, teamName: team.name };
  });

// ---------------------------------------------------------------------------
// DB connection (non-scoped, lives for the DO lifetime)
// ---------------------------------------------------------------------------

const connectDb = async (): Promise<DrizzleDb> => {
  const connectionString =
    env.HYPERDRIVE?.connectionString ?? server.DATABASE_URL;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  const sharedSchema = await import("@executor/storage-postgres/schema");
  const cloudSchema = await import("./services/schema");
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
      resolveTeam(token).pipe(Effect.provide(Services)),
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

    await this.ctx.storage.setAlarm(Date.now() + SESSION_TTL_MS);
  }

  /**
   * Handle an MCP request. The transport manages the full MCP protocol.
   */
  async handleRequest(request: Request): Promise<Response> {
    if (!this.initialized || !this.transport) {
      console.error("[mcp-session] handleRequest called but not initialized");
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Session not initialized" }, id: null }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    try {
      await this.ctx.storage.setAlarm(Date.now() + SESSION_TTL_MS);
      return await this.transport.handleRequest(request);
    } catch (err) {
      console.error("[mcp-session] handleRequest error:", err instanceof Error ? err.stack : err);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err instanceof Error ? err.message : "Internal error" }, id: null }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  }

  async alarm(): Promise<void> {
    await this.cleanup();
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
