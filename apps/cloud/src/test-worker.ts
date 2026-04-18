// ---------------------------------------------------------------------------
// vitest-pool-workers test entry
// ---------------------------------------------------------------------------
//
// Re-exports the real McpSessionDO and drives /mcp + /.well-known/* through
// the same Effect HttpApp the prod worker uses. Only the `McpAuth` service
// is swapped: the real impl calls WorkOS's JWKS endpoint, which can't be
// reached from the test isolate.
//
// `stdio`-transport branch of plugin-mcp is now dynamically imported (see
// packages/plugins/mcp/src/sdk/connection.ts), so `@modelcontextprotocol/
// sdk/client/stdio.js` no longer touches `node:child_process` at module
// load — that was SIGSEGV-ing workerd during test instantiation.
// ---------------------------------------------------------------------------

import { HttpApp } from "@effect/platform";
import { Effect, Layer } from "effect";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import { McpAuth, classifyMcpPath, mcpApp } from "./mcp";
import { organizations } from "./services/schema";
import { parseTestBearer } from "./test-bearer";

export { McpSessionDO } from "./mcp-session";

const TestMcpAuthLive = Layer.succeed(McpAuth, {
  verifyBearer: (request) =>
    Effect.sync(() => {
      const header = request.headers.get("authorization");
      if (!header?.startsWith("Bearer ")) return null;
      return parseTestBearer(header.slice("Bearer ".length));
    }),
});

// ---------------------------------------------------------------------------
// Test seed endpoint
// ---------------------------------------------------------------------------
//
// Exposed at POST /__test__/seed-org. Tests call it via SELF.fetch to insert
// organization rows into the same PGlite-backed database the DO reads from. Doing
// the insert from inside the test worker avoids pulling postgres.js into the
// test file's top-level imports (which segfaulted workerd during test
// module instantiation).
// ---------------------------------------------------------------------------

const seedConnectionString = (envArg: Record<string, unknown>) =>
  (envArg.DATABASE_URL as string | undefined) ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";

// Per-request postgres connection. Sharing a `Sql` across requests breaks
// mid-suite — vitest-pool-workers' isolate resets tear down the socket and
// the next insert errors with "read end of pipe was aborted". Open + close
// per request; the test DO runtime does the same to avoid workerd's
// cross-request I/O guard.
const handleSeedOrg = async (
  request: Request,
  envArg: Record<string, unknown>,
): Promise<Response> => {
  const body = (await request.json()) as { id: string; name: string };
  const sql: Sql = postgres(seedConnectionString(envArg), {
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

const testMcpFetch = HttpApp.toWebHandler(mcpApp.pipe(Effect.provide(TestMcpAuthLive)));

export default {
  async fetch(request: Request, envArg: Record<string, unknown>): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test__/seed-org" && request.method === "POST") {
      return handleSeedOrg(request, envArg);
    }
    if (classifyMcpPath(url.pathname) !== null) {
      return testMcpFetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};
