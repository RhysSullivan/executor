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

import { DbService } from "./db";
import { server } from "../env";

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
        apiKey: server.WORKOS_API_KEY,
        clientId: server.WORKOS_CLIENT_ID,
      },
    }),
  ] as const;

// ---------------------------------------------------------------------------
// Create a fresh executor for a scope (stateless, per-request).
//
// Today "scope" is the WorkOS organization — orgs are the only scope
// level the cloud app exposes. When workspace / user scopes land, this
// function grows to accept a `ScopeStack` instead of a single scope id,
// and nothing downstream (executor, plugins, storage) has to change.
// ---------------------------------------------------------------------------

export const createScopedExecutor = (
  scopeId: string,
  scopeName: string,
) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;

    const plugins = createOrgPlugins();
    const schema = collectSchemas(plugins);
    const adapter = makePostgresAdapter({ db, schema });
    const blobs = makePostgresBlobStore({ db });

    const scope = new Scope({
      id: ScopeId.make(scopeId),
      name: scopeName,
      createdAt: new Date(),
    });

    return yield* createExecutor({ scope, adapter, blobs, plugins });
  });
