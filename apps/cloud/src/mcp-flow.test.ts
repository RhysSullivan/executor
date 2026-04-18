// ---------------------------------------------------------------------------
// /mcp — end-to-end tests via SELF.fetch into the workerd test pool
// ---------------------------------------------------------------------------
//
// These tests drive the real pipeline, not a stub:
//
//   SELF.fetch
//     → test-worker's default.fetch
//     → HttpApp.toWebHandler(mcpApp, { McpAuth: test })
//     → mcpApp: CORS / OAuth metadata / auth / dispatch
//     → env.MCP_SESSION.newUniqueId() → stub.init() → stub.handleRequest()
//     → the real McpSessionDO — real DO storage, real engine, real
//        @modelcontextprotocol/sdk McpServer over WorkerTransport
//     → real postgres (via PGlite socket started by test-globalsetup.ts)
//
// Only one seam is faked: `McpAuth.verifyBearer`. The real impl calls
// WorkOS's JWKS endpoint, which we can't reach from the test isolate.
// Test bearer format is `test-accept::<accountId>::<orgId|none>`
// (see `makeTestBearer` in test-worker.ts).
//
// The node-pool test (`mcp-session.e2e.node.test.ts`) covers the DO's
// internal wiring with an InMemoryTransport and skips HTTP entirely.
// This suite is its complement: it drives the HTTP path and proves that
// every layer between `fetch()` and the DO is real.
//
// Test-only concession: wrangler.test.jsonc sets
// `MCP_SESSION_REQUEST_SCOPED_RUNTIME=true`, so the real McpSessionDO keeps
// its MCP transport/session state in DO storage but rebuilds the
// postgres-backed engine per POST/DELETE request. That avoids workerd's
// cross-request `RefcountedFulfiller` guard while still driving the real
// HTTP → DO → MCP transport → engine pipeline across multiple requests.
// ---------------------------------------------------------------------------

import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeTestBearer } from "./test-bearer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE = "https://test-resource.example.com";
const MCP_URL = `${BASE}/mcp`;
const OAUTH_RESOURCE_URL = `${BASE}/.well-known/oauth-protected-resource`;

const JSON_AND_SSE = "application/json, text/event-stream";
const CONTENT_TYPE_JSON = "application/json";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-flow-e2e", version: "0.0.1" },
  },
};

const INITIALIZED_NOTIFICATION = {
  jsonrpc: "2.0" as const,
  method: "notifications/initialized",
  params: {},
};

const TOOLS_LIST_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 2,
  method: "tools/list",
  params: {},
};

const EXECUTE_REQUEST = {
  jsonrpc: "2.0" as const,
  id: 3,
  method: "tools/call",
  params: {
    name: "execute",
    arguments: { code: "return 1 + 2" },
  },
};

// ---------------------------------------------------------------------------
// SSE parsing — the MCP transport returns `text/event-stream` with a single
// `event: message\ndata: {...}` payload per request. We only need the first
// data line; the stream closes immediately after.
// ---------------------------------------------------------------------------

const readFirstSseMessage = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const body = await response.text();
    const dataLine = body
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!dataLine) {
      throw new Error(`no SSE data line in body: ${JSON.stringify(body)}`);
    }
    return JSON.parse(dataLine.slice("data: ".length));
  }
  // enableJsonResponse path returns plain JSON
  return response.json();
};

// ---------------------------------------------------------------------------
// Seeding — goes through the test worker's `/__test__/seed-org` endpoint
// because importing `postgres` / `drizzle-orm/postgres-js` at the test-file
// level segfaults workerd at module load. The seed endpoint uses the same
// PGlite-backed database the DO uses, so `resolveOrganization` sees the
// seeded row without the test file importing postgres.js at top level.
// ---------------------------------------------------------------------------

const seedOrg = async (orgId: string, orgName: string) => {
  const response = await SELF.fetch(`${BASE}/__test__/seed-org`, {
    method: "POST",
    headers: { "content-type": CONTENT_TYPE_JSON },
    body: JSON.stringify({ id: orgId, name: orgName }),
  });
  if (!response.ok) {
    throw new Error(`seed-org failed: ${response.status} ${await response.text()}`);
  }
};

const nextOrgId = (() => {
  let seq = 0;
  return () => `org_mcp_flow_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
})();

const nextAccountId = (() => {
  let seq = 0;
  return () => `user_mcp_flow_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
})();

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type McpPostInit = {
  readonly bearer?: string;
  readonly sessionId?: string | null;
  readonly body: unknown;
  readonly accept?: string;
};

const mcpPost = (init: McpPostInit): Promise<Response> => {
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPE_JSON,
    accept: init.accept ?? JSON_AND_SSE,
  };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.sessionId) headers["mcp-session-id"] = init.sessionId;
  return SELF.fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(init.body),
  });
};

const mcpDelete = (init: Omit<McpPostInit, "body" | "accept">): Promise<Response> => {
  const headers: Record<string, string> = {
    accept: JSON_AND_SSE,
  };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.sessionId) headers["mcp-session-id"] = init.sessionId;
  return SELF.fetch(MCP_URL, {
    method: "DELETE",
    headers,
  });
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Env presence guard — avoids confusing errors downstream if the test
  // wrangler forgot to bind something the DO needs.
  if (!env.MCP_SESSION) throw new Error("MCP_SESSION binding missing from test wrangler");
});

afterAll(() => undefined);

// ---------------------------------------------------------------------------
// 1. OPTIONS preflight on /mcp
// ---------------------------------------------------------------------------

describe("/mcp CORS preflight", () => {
  it("returns 204 with the expected CORS headers", async () => {
    const response = await SELF.fetch(MCP_URL, {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, mcp-session-id",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, DELETE, OPTIONS",
    );
    const allowedHeaders = response.headers.get("access-control-allow-headers") ?? "";
    expect(allowedHeaders).toContain("mcp-session-id");
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain("content-type");
    expect(response.headers.get("access-control-expose-headers")).toBe("mcp-session-id");
  });
});

// ---------------------------------------------------------------------------
// 2. OAuth protected resource metadata
// ---------------------------------------------------------------------------

describe("/.well-known/oauth-protected-resource", () => {
  it("returns the protected resource metadata with CORS", async () => {
    const response = await SELF.fetch(OAUTH_RESOURCE_URL);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      resource: "https://test-resource.example.com",
      authorization_servers: ["https://test-authkit.example.com"],
      bearer_methods_supported: ["header"],
      scopes_supported: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 3. POST /mcp without Authorization
// ---------------------------------------------------------------------------

describe("/mcp unauthorized", () => {
  it("returns 401 with www-authenticate and an error body", async () => {
    const response = await mcpPost({ body: INITIALIZE_REQUEST });
    expect(response.status).toBe(401);
    const wwwAuth = response.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toContain("Bearer resource_metadata=");
    expect(wwwAuth).toContain(
      "https://test-resource.example.com/.well-known/oauth-protected-resource",
    );
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});

// ---------------------------------------------------------------------------
// 4. POST /mcp with a valid bearer but no org in the token
// ---------------------------------------------------------------------------

describe("/mcp verified token without org", () => {
  it("returns JSON-RPC -32001", async () => {
    const response = await mcpPost({
      bearer: makeTestBearer(nextAccountId(), null),
      body: INITIALIZE_REQUEST,
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/No organization/i);
  });
});

// ---------------------------------------------------------------------------
// 5. POST /mcp initialize (valid token with org) — reaches the DO
// ---------------------------------------------------------------------------

describe("/mcp initialize reaches the DO", () => {
  it("returns a JSON-RPC initialize result with mcp-session-id", async () => {
    const orgId = nextOrgId();
    await seedOrg(orgId, "Init Org");

    const response = await mcpPost({
      bearer: makeTestBearer(nextAccountId(), orgId),
      body: INITIALIZE_REQUEST,
    });

    expect(response.status).toBe(200);
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(sessionId!.length).toBeGreaterThan(0);

    const message = (await readFirstSseMessage(response)) as {
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: Record<string, unknown>;
      };
    };
    expect(message.jsonrpc).toBe("2.0");
    expect(message.id).toBe(1);
    expect(message.result.protocolVersion).toBeTruthy();
    expect(message.result.serverInfo.name).toBe("executor");
    expect(message.result.capabilities.tools).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Full handshake: initialize → notifications/initialized → tools/list
// ---------------------------------------------------------------------------

describe("/mcp multi-request handshake", () => {
  it("supports initialize → initialized → tools/list on one DO session", async () => {
    const orgId = nextOrgId();
    const bearer = makeTestBearer(nextAccountId(), orgId);
    await seedOrg(orgId, "Handshake Org");

    const initializeResponse = await mcpPost({
      bearer,
      body: INITIALIZE_REQUEST,
    });
    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const initializeMessage = (await readFirstSseMessage(initializeResponse)) as {
      jsonrpc: string;
      id: number;
      result: {
        serverInfo: { name: string };
      };
    };
    expect(initializeMessage.jsonrpc).toBe("2.0");
    expect(initializeMessage.id).toBe(1);
    expect(initializeMessage.result.serverInfo.name).toBe("executor");

    const initializedResponse = await mcpPost({
      bearer,
      sessionId,
      body: INITIALIZED_NOTIFICATION,
    });
    expect(initializedResponse.status).toBe(202);

    const toolsListResponse = await mcpPost({
      bearer,
      sessionId,
      body: TOOLS_LIST_REQUEST,
    });
    expect(toolsListResponse.status).toBe(200);
    expect(toolsListResponse.headers.get("mcp-session-id")).toBe(sessionId);

    const toolsListMessage = (await readFirstSseMessage(toolsListResponse)) as {
      jsonrpc: string;
      id: number;
      result: {
        tools: Array<{ name: string }>;
      };
    };
    expect(toolsListMessage.jsonrpc).toBe("2.0");
    expect(toolsListMessage.id).toBe(2);
    expect(toolsListMessage.result.tools.map((tool) => tool.name)).toContain("execute");
  });
});

// ---------------------------------------------------------------------------
// 7. Full tool execution across multiple requests on one DO session
// ---------------------------------------------------------------------------

describe("/mcp multi-request tools/call", () => {
  it("executes code after initialize and initialized on the same session", async () => {
    const orgId = nextOrgId();
    const bearer = makeTestBearer(nextAccountId(), orgId);
    await seedOrg(orgId, "Execute Org");

    const initializeResponse = await mcpPost({
      bearer,
      body: INITIALIZE_REQUEST,
    });
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await readFirstSseMessage(initializeResponse);

    const initializedResponse = await mcpPost({
      bearer,
      sessionId,
      body: INITIALIZED_NOTIFICATION,
    });
    expect(initializedResponse.status).toBe(202);

    const executeResponse = await mcpPost({
      bearer,
      sessionId,
      body: EXECUTE_REQUEST,
    });
    expect(executeResponse.status).toBe(200);

    const executeMessage = (await readFirstSseMessage(executeResponse)) as {
      jsonrpc: string;
      id: number;
      result: {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
    };
    expect(executeMessage.jsonrpc).toBe("2.0");
    expect(executeMessage.id).toBe(3);
    expect(executeMessage.result.isError).not.toBe(true);
    expect(executeMessage.result.content[0]?.text).toContain("3");
  });
});

// ---------------------------------------------------------------------------
// 8. DELETE /mcp tears down the session
// ---------------------------------------------------------------------------

describe("/mcp delete tears down session", () => {
  it("returns stale-session on the next request", async () => {
    const orgId = nextOrgId();
    const bearer = makeTestBearer(nextAccountId(), orgId);
    await seedOrg(orgId, "Delete Org");

    const initializeResponse = await mcpPost({
      bearer,
      body: INITIALIZE_REQUEST,
    });
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await readFirstSseMessage(initializeResponse);

    const deleteResponse = await mcpDelete({ bearer, sessionId });
    expect(deleteResponse.status).toBe(200);

    const staleResponse = await mcpPost({
      bearer,
      sessionId,
      body: TOOLS_LIST_REQUEST,
    });
    expect(staleResponse.status).toBe(404);
    const staleBody = (await staleResponse.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(staleBody.jsonrpc).toBe("2.0");
    expect(staleBody.error.code).toBe(-32001);
    expect(staleBody.error.message).toMatch(/timed out/i);
  });
});

// ---------------------------------------------------------------------------
// 9. POST /mcp on an unknown session-id
// ---------------------------------------------------------------------------
//
// A DO id that was never initialized behaves just like a timed-out
// session — `handleRequest` short-circuits on `!this.initialized`. The
// DO id must be a valid hex id for the namespace or `idFromString`
// throws; generate a fresh unique one (never used) rather than hand-rolling.
// ---------------------------------------------------------------------------

describe("/mcp unknown session id", () => {
  it("returns the session-timeout JSON-RPC error", async () => {
    // No seedOrg needed — the DO never reaches init() (its `initialized`
    // flag is still false), so `resolveOrganization` never runs.
    const bearer = makeTestBearer(nextAccountId(), nextOrgId());

    const staleSessionId = env.MCP_SESSION.newUniqueId().toString();

    const response = await mcpPost({
      bearer,
      sessionId: staleSessionId,
      body: TOOLS_LIST_REQUEST,
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toMatch(/timed out/i);
  });
});
