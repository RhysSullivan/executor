// ---------------------------------------------------------------------------
// MCP Session Durable Object — holds MCP server + engine per session
// ---------------------------------------------------------------------------

import { DurableObject, env } from "cloudflare:workers";
import { Data, Effect, Layer } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkerTransport, type TransportState } from "agents/mcp";

import { createExecutorMcpServer } from "@executor/host-mcp";
import { makeDynamicWorkerExecutor } from "@executor/runtime-dynamic-worker";

import { UserStoreService } from "./auth/context";
import { server } from "./env";
import { createOrgExecutor } from "./services/executor";
import { DbService } from "./services/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpSessionInit = {
  organizationId: string;
};

// Heartbeat interval — keeps the DO alive by re-scheduling an alarm before
// Cloudflare's ~60s idle eviction kicks in.
const HEARTBEAT_MS = 30 * 1000;

// Session timeout — clean up after no requests for this long.
// TODO: Make tier-based — free users get 60s, paid users get 5 minutes.
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Session initialization effect
// ---------------------------------------------------------------------------

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
const Services = Layer.mergeAll(DbLive, UserStoreLive);

class OrganizationNotFoundError extends Data.TaggedError("OrganizationNotFoundError")<{
  readonly organizationId: string;
}> {}

const initSession = (organizationId: string) =>
  Effect.gen(function* () {
    const users = yield* UserStoreService;
    const org = yield* users.use((store) => store.getOrganization(organizationId));

    if (!org) {
      return yield* new OrganizationNotFoundError({ organizationId });
    }

    const executor = yield* createOrgExecutor(org.id, org.name, server.ENCRYPTION_KEY);

    const codeExecutor = makeDynamicWorkerExecutor({ loader: env.LOADER });
    const mcpServer = yield* Effect.promise(() =>
      createExecutorMcpServer({ executor, codeExecutor }),
    );

    return mcpServer;
  }).pipe(Effect.provide(Services));

// ---------------------------------------------------------------------------
// JSON-RPC error response helper
// ---------------------------------------------------------------------------

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class McpSessionDO extends DurableObject {
  private mcpServer: McpServer | null = null;
  private transport: WorkerTransport | null = null;
  private initialized = false;
  private lastActivityMs = 0;

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

    this.mcpServer = await Effect.runPromise(initSession(token.organizationId));

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
      return jsonRpcError(500, -32603, err instanceof Error ? err.message : "Internal error");
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
    this.initialized = false;
  }
}
