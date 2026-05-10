// ---------------------------------------------------------------------------
// Alchemy local HTTP test entry
// ---------------------------------------------------------------------------
//
// This Worker is only used by the Alchemy local-runtime MCP e2e suite. It
// drives the real MCP app and real Durable Object binding over workerd HTTP,
// but swaps bearer verification for deterministic test tokens.

import * as Runtime from "alchemy/Cloudflare/Workers/Runtime";
import { Worker } from "alchemy/Cloudflare/Workers/Worker";
import { Effect, Layer } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import {
  McpAuth,
  McpOrganizationAuth,
  classifyMcpPath,
  mcpApp,
  mcpAuthorized,
  mcpUnauthorized,
} from "./mcp";
import { McpJwtVerificationError } from "./mcp-auth";
import McpSessionDO from "./mcp-session";
import { organizations } from "./services/schema";
import { DoTelemetryLive } from "./services/telemetry";
import { parseTestBearer } from "./test-bearer";

const TEST_BEARER_PREFIX = "Bearer ";

const TestMcpAuthLive = Layer.succeed(McpAuth)({
  verifyBearer: (request) =>
    Effect.gen(function* () {
      const header = request.headers.get("authorization");
      if (!header?.startsWith(TEST_BEARER_PREFIX)) return mcpUnauthorized("missing_bearer");
      const rawToken = header.slice(TEST_BEARER_PREFIX.length);
      if (rawToken === "test-system-error") {
        return yield* new McpJwtVerificationError({
          cause: "simulated_jwks_fetch_failure",
          reason: "system",
        });
      }
      const token = parseTestBearer(rawToken);
      return token ? mcpAuthorized(token) : mcpUnauthorized("invalid_token");
    }),
});

const TestMcpOrganizationAuthLive = Layer.succeed(McpOrganizationAuth)({
  authorize: (_accountId, organizationId) => Effect.succeed(!organizationId.startsWith("revoked_")),
});

const TestMcpLayers = Layer.mergeAll(TestMcpAuthLive, TestMcpOrganizationAuthLive, DoTelemetryLive);

const connectionString = (envArg: Env): string =>
  envArg.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";

export const workerEnv = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
  EXECUTOR_DIRECT_DATABASE_URL: "true",
  MCP_AUTHKIT_DOMAIN: "https://test-authkit.example.com",
  MCP_RESOURCE_ORIGIN: "https://test-resource.example.com",
  NODE_ENV: "test",
  WORKOS_API_KEY: "test_api_key",
  WORKOS_CLIENT_ID: "test_client_id",
  WORKOS_COOKIE_PASSWORD: "test_cookie_password_at_least_32_chars!",
};

export class McpAlchemyTestWorker extends Worker<McpAlchemyTestWorker>()(
  "McpAlchemyTestWorker",
  { env: workerEnv, main: import.meta.filename },
) {}

const handleSeedOrg = async (request: Request, envArg: Env): Promise<Response> => {
  const body = (await request.json()) as { id: string; name: string };
  const sql: Sql = postgres(connectionString(envArg), {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 30,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
  try {
    await drizzle(sql, { schema: { organizations } })
      .insert(organizations)
      .values({ id: body.id, name: body.name })
      .onConflictDoUpdate({
        target: organizations.id,
        set: { name: body.name },
      });
  } finally {
    await sql.end({ timeout: 0 }).catch(() => undefined);
  }
  return new Response(null, { status: 204 });
};

const workerImpl = Effect.gen(function* () {
  const mcpSession = yield* McpSessionDO;

  return {
    fetch: Effect.gen(function* () {
      const httpRequest = yield* HttpServerRequest.HttpServerRequest;
      const request = httpRequest.source as Request;
      const runtimeEnv = yield* Runtime.WorkerEnvironment.typed<Env>();
      const env = {
        ...runtimeEnv,
        MCP_SESSION: mcpSession,
        LOADER: runtimeEnv.LOADER,
      } satisfies Env;

      const url = new URL(request.url);
      if (url.pathname === "/__test__/seed-org" && request.method === "POST") {
        return HttpServerResponse.raw(yield* Effect.promise(() => handleSeedOrg(request, env)));
      }
      if (url.pathname === "/__test__/new-session-id") {
        return HttpServerResponse.jsonUnsafe({
          sessionId: env.MCP_SESSION.newUniqueId().toString(),
        });
      }
      if (classifyMcpPath(url.pathname) !== null) {
        return yield* mcpApp.pipe(
          Effect.provide(TestMcpLayers),
          Effect.provideService(Runtime.WorkerEnvironment, env),
        );
      }
      return HttpServerResponse.text("not found", { status: 404 });
    }),
  };
}).pipe(Effect.orDie);

export default McpAlchemyTestWorker.asEffect().pipe(
  Effect.provide(McpAlchemyTestWorker.make(workerImpl)),
);
