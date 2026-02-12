import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { AnonymousOAuthServer, InMemoryOAuthStorage, OAuthBadRequest } from "./anonymous-oauth";
import { handleMcpRequest, type McpWorkspaceContext } from "./mcp-server";
import type { AnonymousContext, CreateTaskInput, TaskRecord, ToolDescriptor } from "./types";
import type { LiveTaskEvent } from "./events";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * End-to-end test: MCP SDK client with OAuth provider → self-issued anonymous
 * auth server → MCP handler.
 *
 * This proves a real MCP client (Claude Desktop, Cursor, etc.) can complete the
 * standard OAuth flow against our anonymous auth server and make tool calls.
 */

// ---------------------------------------------------------------------------
// Fake MCP service (same pattern as mcp-server.test.ts)
// ---------------------------------------------------------------------------

class FakeMcpService {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly sessions = new Map<string, AnonymousContext>();
  private readonly listeners = new Map<string, Set<(event: LiveTaskEvent) => void>>();

  async createTask(input: CreateTaskInput): Promise<{ task: TaskRecord }> {
    const id = `task_${crypto.randomUUID()}`;
    const now = Date.now();
    const queued: TaskRecord = {
      id,
      code: input.code,
      runtimeId: input.runtimeId ?? "local-bun",
      status: "queued",
      timeoutMs: input.timeoutMs ?? 15_000,
      metadata: input.metadata ?? {},
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      clientId: input.clientId,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, queued);

    queueMicrotask(() => {
      const current = this.tasks.get(id);
      if (!current) return;
      this.tasks.set(id, {
        ...current,
        status: "completed",
        startedAt: current.createdAt + 1,
        completedAt: current.createdAt + 2,
        updatedAt: current.createdAt + 2,
        exitCode: 0,
        result: { ran: input.code.slice(0, 20) },
      });
      for (const listener of this.listeners.get(id) ?? []) {
        listener({ id: 1, eventName: "task", payload: { status: "completed" }, createdAt: Date.now() });
      }
    });

    return { task: queued };
  }

  async getTask(taskId: string, workspaceId?: string): Promise<TaskRecord | null> {
    const task = this.tasks.get(taskId) ?? null;
    if (!task) return null;
    if (workspaceId && task.workspaceId !== workspaceId) return null;
    return task;
  }

  async bootstrapAnonymousContext(sessionId?: string): Promise<AnonymousContext> {
    if (sessionId && this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId)!;
      return { ...existing, lastSeenAt: Date.now() };
    }

    const now = Date.now();
    const context: AnonymousContext = {
      sessionId: sessionId ?? `anon_session_${crypto.randomUUID()}`,
      workspaceId: `ws_${crypto.randomUUID()}` as Id<"workspaces">,
      actorId: `anon_${crypto.randomUUID()}`,
      clientId: "mcp",
      accountId: `account_${crypto.randomUUID()}`,
      userId: `user_${crypto.randomUUID()}`,
      createdAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(context.sessionId, context);
    return context;
  }

  subscribe(taskId: string, listener: (event: LiveTaskEvent) => void): () => void {
    const set = this.listeners.get(taskId) ?? new Set();
    set.add(listener);
    this.listeners.set(taskId, set);
    return () => { set.delete(listener); };
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      { path: "utils.get_time", description: "Get the current time", approval: "auto" },
    ];
  }

  async listToolsForTypecheck(
    _context: { workspaceId: string; actorId?: string; clientId?: string },
  ): Promise<{ tools: ToolDescriptor[]; dtsUrls: Record<string, string> }> {
    return { tools: await this.listTools(), dtsUrls: {} };
  }
}

// ---------------------------------------------------------------------------
// In-memory OAuthClientProvider that programmatically drives the PKCE flow
// ---------------------------------------------------------------------------

class TestOAuthClientProvider implements OAuthClientProvider {
  private _clientInfo: { client_id: string; client_secret?: string } | undefined;
  private _tokens: { access_token: string; token_type: string; expires_in?: number } | undefined;
  private _codeVerifier: string | undefined;
  public capturedAuthorizationUrl: URL | undefined;

  get redirectUrl(): string {
    // Must return a redirect_uri that we registered
    return "http://localhost:0/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: ["http://localhost:0/callback"],
      client_name: "mcp-oauth-sdk-test",
    };
  }

  clientInformation() {
    return this._clientInfo;
  }

  saveClientInformation(info: any) {
    this._clientInfo = info;
  }

  tokens() {
    return this._tokens;
  }

  saveTokens(tokens: any) {
    this._tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL) {
    // Capture the URL so the test can programmatically follow it
    this.capturedAuthorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(verifier: string) {
    this._codeVerifier = verifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) throw new Error("No code verifier");
    return this._codeVerifier;
  }
}

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let oauthServer: AnonymousOAuthServer;
let mcpService: FakeMcpService;

beforeAll(async () => {
  mcpService = new FakeMcpService();

  // We start the server first with a placeholder issuer, then re-init with the real one
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;

      // ── OAuth discovery ─────────────────────────────────────────────
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        });
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          jwks_uri: `${origin}/oauth2/jwks`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      }

      if (url.pathname === "/oauth2/jwks") {
        return Response.json(oauthServer.getJwks());
      }

      // ── OAuth endpoints ─────────────────────────────────────────────
      if (url.pathname === "/register" && request.method === "POST") {
        const body = await request.json();
        try {
          const reg = await oauthServer.registerClient(body as any);
          return Response.json(reg, { status: 201 });
        } catch (e) {
          if (e instanceof OAuthBadRequest) {
            return Response.json({ error: "invalid_client_metadata", error_description: e.message }, { status: 400 });
          }
          throw e;
        }
      }

      if (url.pathname === "/authorize" && request.method === "GET") {
        try {
          const { redirectTo } = await oauthServer.authorize(url.searchParams);
          return Response.redirect(redirectTo, 302);
        } catch (e) {
          if (e instanceof OAuthBadRequest) {
            return Response.json({ error: "invalid_request", error_description: e.message }, { status: 400 });
          }
          throw e;
        }
      }

      if (url.pathname === "/token" && request.method === "POST") {
        const text = await request.text();
        try {
          const tokens = await oauthServer.exchangeToken(new URLSearchParams(text));
          return Response.json(tokens, { headers: { "cache-control": "no-store" } });
        } catch (e) {
          if (e instanceof OAuthBadRequest) {
            return Response.json({ error: "invalid_grant", error_description: e.message }, { status: 400 });
          }
          throw e;
        }
      }

      // ── MCP endpoint (with token verification) ──────────────────────
      if (url.pathname === "/mcp") {
        const authHeader = request.headers.get("authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return Response.json(
            { error: "Authorization required" },
            {
              status: 401,
              headers: {
                "WWW-Authenticate": [
                  'Bearer error="unauthorized"',
                  'error_description="Authorization needed"',
                  `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
                ].join(", "),
              },
            },
          );
        }

        const token = authHeader.slice("Bearer ".length).trim();
        const verified = await oauthServer.verifyToken(token);
        if (!verified) {
          return Response.json(
            { error: "Invalid token" },
            {
              status: 401,
              headers: {
                "WWW-Authenticate": [
                  'Bearer error="invalid_token"',
                  `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
                ].join(", "),
              },
            },
          );
        }

        // Token is valid — hand off to the MCP handler (no workspace context, anonymous)
        return await handleMcpRequest(mcpService, request);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  baseUrl = `http://127.0.0.1:${server.port}`;
  oauthServer = new AnonymousOAuthServer({
    issuer: baseUrl,
    storage: new InMemoryOAuthStorage(),
  });
  await oauthServer.init();
});

afterAll(() => {
  server?.stop(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP SDK Client OAuth E2E", () => {
  test("full SDK OAuth flow: connect with auth provider → auto-discover → register → authorize → token → tool call", async () => {
    const provider = new TestOAuthClientProvider();
    const mcpUrl = new URL(`${baseUrl}/mcp`);
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      authProvider: provider,
    });
    const client = new Client(
      { name: "oauth-e2e-test", version: "1.0.0" },
      { capabilities: {} },
    );

    // Step 1: connect() will hit 401 → SDK discovers auth server → registers client → calls redirectToAuthorization
    // The interactive PKCE flow throws UnauthorizedError because it needs the user to complete auth
    try {
      await client.connect(transport);
      // If connect succeeds (e.g., tokens already present), that's fine too
    } catch (error) {
      // Expected: UnauthorizedError because the SDK called redirectToAuthorization
      // and we need to programmatically complete the flow
      expect(error).toBeInstanceOf(UnauthorizedError);
    }

    // Step 2: Provider should have captured the authorization URL
    expect(provider.capturedAuthorizationUrl).toBeDefined();
    const authUrl = provider.capturedAuthorizationUrl!;
    expect(authUrl.pathname).toBe("/authorize");
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");

    // Step 3: Programmatically follow the authorization URL (our server auto-approves)
    const authResponse = await fetch(authUrl.toString(), { redirect: "manual" });
    expect(authResponse.status).toBe(302);
    const location = authResponse.headers.get("location")!;
    expect(location).toBeTruthy();

    const callbackUrl = new URL(location);
    const code = callbackUrl.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // Step 4: Complete the auth flow — SDK exchanges code for token
    await transport.finishAuth(code);

    // Step 5: Create a new transport + client (the old transport was already started
    // by the first connect call — the SDK doesn't allow re-starting it).
    // The provider now has tokens stored, so this connection will succeed.
    const transport2 = new StreamableHTTPClientTransport(mcpUrl, {
      authProvider: provider,
    });
    const client2 = new Client(
      { name: "oauth-e2e-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await client2.connect(transport2);

    // Step 6: Make a tool call — this uses the Bearer token automatically
    const tools = await client2.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    expect(tools.tools[0].name).toBe("run_code");

    const result = (await client2.callTool({
      name: "run_code",
      arguments: {
        code: "return 42",
      },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
    };

    expect(result.isError).toBeUndefined();
    const text = result.content.find((part) => part.type === "text");
    expect(text?.text).toContain("status: completed");

    // Verify the structuredContent has anonymous identifiers
    const structured = result.structuredContent;
    expect(typeof structured?.workspaceId).toBe("string");
    expect(typeof structured?.actorId).toBe("string");

    // Cleanup
    await transport2.close().catch(() => {});
    await client2.close().catch(() => {});
  });
});
