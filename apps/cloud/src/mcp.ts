// ---------------------------------------------------------------------------
// Cloud MCP Server — stateless Streamable HTTP with WorkOS OAuth
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createExecutorMcpServer } from "@executor/host-mcp";
import { makeDynamicWorkerExecutor } from "@executor/runtime-dynamic-worker";

import { UserStoreService } from "./auth/context";
import { server } from "./env";
import { createTeamExecutor } from "./services/executor";
import { DbService } from "./services/db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHKIT_DOMAIN = "https://signin.executor.sh";
const RESOURCE_ORIGIN = "https://executor.sh";
const JWKS_URL = new URL(`${AUTHKIT_DOMAIN}/.well-known/jwks.json`);

const jwks = createRemoteJWKSet(JWKS_URL);

// ---------------------------------------------------------------------------
// OAuth metadata endpoints
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });

const protectedResourceMetadata = () =>
  jsonResponse({
    resource: RESOURCE_ORIGIN,
    authorization_servers: [AUTHKIT_DOMAIN],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
  });

const authorizationServerMetadata = () =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${AUTHKIT_DOMAIN}/.well-known/openid-configuration`);
      if (!res.ok) return jsonResponse({ error: "upstream_error" }, 502);
      return jsonResponse(await res.json());
    },
    catch: () => jsonResponse({ error: "upstream_error" }, 502),
  }).pipe(Effect.catchAll((res) => Effect.succeed(res)));

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

type VerifiedToken = {
  sub: string;
  email?: string;
  firstName?: string;
  lastName?: string;
};

const verifyBearerToken = (request: Request) =>
  Effect.gen(function* () {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;

    const token = authHeader.slice(7);
    return yield* Effect.tryPromise({
      try: async () => {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: AUTHKIT_DOMAIN,
        });
        if (!payload.sub) return null;
        return {
          sub: payload.sub,
          email: payload.email as string | undefined,
          firstName: payload.first_name as string | undefined,
          lastName: payload.last_name as string | undefined,
        } satisfies VerifiedToken;
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
  });

const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${RESOURCE_ORIGIN}/.well-known/oauth-protected-resource"`,
      "access-control-allow-origin": "*",
    },
  });

// ---------------------------------------------------------------------------
// Shared services
// ---------------------------------------------------------------------------

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "content-type": "application/json" } },
  );

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));
const McpServices = Layer.mergeAll(DbLive, UserStoreLive);

// ---------------------------------------------------------------------------
// Team resolution (mirrors api.ts resolveTeamId)
// ---------------------------------------------------------------------------

const resolveTeam = (token: VerifiedToken) =>
  Effect.gen(function* () {
    const users = yield* UserStoreService;
    const teams = yield* users.use((store) => store.getTeamsForUser(token.sub));

    if (teams.length > 0) {
      return { teamId: teams[0]!.teamId, teamName: teams[0]!.teamName ?? "Team" };
    }

    const name =
      [token.firstName, token.lastName].filter(Boolean).join(" ") || undefined;
    const user = yield* users.use((store) =>
      store.upsertUser({
        id: token.sub,
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
// MCP POST handler
// ---------------------------------------------------------------------------

const closeExecutor = (executor: { close: () => Effect.Effect<void, unknown> }) =>
  executor.close().pipe(Effect.orElseSucceed(() => undefined));

const handleMcpPost = (request: Request, token: VerifiedToken) =>
  Effect.gen(function* () {
    const { teamId, teamName } = yield* resolveTeam(token);

    const executor = yield* Effect.acquireRelease(
      createTeamExecutor(teamId, teamName, server.ENCRYPTION_KEY),
      closeExecutor,
    );

    const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
    const codeExecutor = makeDynamicWorkerExecutor({ loader: (env as any).LOADER });
    const mcpServer = yield* Effect.promise(() =>
      createExecutorMcpServer({ executor, codeExecutor }),
    );

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    yield* Effect.promise(() => mcpServer.connect(transport));
    return yield* Effect.promise(() => transport.handleRequest(request));
  });

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

export const handleMcpRequest = async (
  request: Request,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // CORS preflight for MCP paths
  if (request.method === "OPTIONS" && (pathname === "/mcp" || pathname.startsWith("/.well-known/"))) {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, mcp-session-id",
      },
    });
  }

  // Well-known endpoints (public, no auth)
  if (pathname === "/.well-known/oauth-protected-resource") {
    return protectedResourceMetadata();
  }
  if (pathname === "/.well-known/oauth-authorization-server") {
    return Effect.runPromise(authorizationServerMetadata());
  }

  // MCP endpoint
  if (pathname !== "/mcp") return null;

  if (request.method === "GET") {
    return jsonRpcError(405, -32001, "SSE sessions not supported");
  }
  if (request.method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") {
    return jsonRpcError(405, -32001, "Method not allowed");
  }

  return Effect.runPromise(
    Effect.gen(function* () {
      const token = yield* verifyBearerToken(request);
      if (!token) return unauthorized();
      return yield* handleMcpPost(request, token);
    }).pipe(
      Effect.scoped,
      Effect.provide(McpServices),
    ),
  );
};
