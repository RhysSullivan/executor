// ---------------------------------------------------------------------------
// Cloud executor — stateless, per-request, new SDK shape
// ---------------------------------------------------------------------------
//
// Each invocation of `createScopedExecutor` runs inside a request-scoped
// Effect and yields a fresh executor bound to the current DbService's
// per-request postgres.js client. Cloudflare Workers + Hyperdrive demand
// fresh connections per request, so "build once" means "once per request"
// here.

import { Effect } from "effect";

import {
  Scope,
  ScopeId,
  collectSchemas,
  createExecutor,
} from "@executor/sdk";
import {
  makePostgresAdapter,
  makePostgresBlobStore,
} from "@executor/storage-postgres";
import { openApiPlugin } from "@executor/plugin-openapi";
import { mcpPlugin } from "@executor/plugin-mcp";
import { graphqlPlugin } from "@executor/plugin-graphql";
import { workosVaultPlugin } from "@executor/plugin-workos-vault";

import { env } from "cloudflare:workers";
import { DbService } from "./db";

// ---------------------------------------------------------------------------
// Plugin list — one place, used for both the runtime and the CLI config
// (executor.config.ts). No stdio MCP in cloud; no keychain/file-secrets/
// 1password/google-discovery.
//
// NOTE: the CLI config (executor.config.ts) imports these same plugins with
// stub credentials because it only reads `plugin.schema`. Here we pass
// real credentials from the env.
// ---------------------------------------------------------------------------

const createOrgPlugins = () =>
  [
    openApiPlugin(),
    mcpPlugin({ dangerouslyAllowStdioMCP: false }),
    graphqlPlugin(),
    workosVaultPlugin({
      credentials: {
        apiKey: env.WORKOS_API_KEY,
        clientId: env.WORKOS_CLIENT_ID,
      },
    }),
  ] as const;

// ---------------------------------------------------------------------------
// Create a fresh executor for a (user, org) pair (stateless, per-request).
//
// Scope stack is `[userOrgScope, orgScope]` — innermost first. The
// user-within-org scope id (`user-org:${userId}:${orgId}`) intentionally
// includes the org id so the same WorkOS user in a different org gets a
// distinct scope row; future workspace scopes can slot in between without
// conflicting with a hypothetical global user scope.
//
// OAuth tokens land at `ctx.scopes[0]` (the user-org scope) by default, so
// a member's access/refresh tokens can't leak to other members via
// `secrets.list`, while source rows and org-wide credentials live on the
// outer scope.
// ---------------------------------------------------------------------------

export const createScopedExecutor = (
  userId: string,
  organizationId: string,
  organizationName: string,
) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;

    const plugins = createOrgPlugins();
    const schema = collectSchemas(plugins);
    const adapter = makePostgresAdapter({ db, schema });
    const blobs = makePostgresBlobStore({ db });

    const orgScope = new Scope({
      id: ScopeId.make(organizationId),
      name: organizationName,
      createdAt: new Date(),
    });
    const userOrgScope = new Scope({
      id: ScopeId.make(`user-org:${userId}:${organizationId}`),
      name: `Personal · ${organizationName}`,
      createdAt: new Date(),
    });

    // The executor surface returns raw `StorageFailure`; translation to
    // the opaque `InternalError({ traceId })` happens at the HTTP edge
    // via `withCapture` (see `api/protected-layers.ts`). That's
    // where `ErrorCaptureLive` (Sentry) gets wired in.
    return yield* createExecutor({
      scopes: [userOrgScope, orgScope],
      adapter,
      blobs,
      plugins,
    });
  });
