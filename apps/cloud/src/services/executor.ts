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
  ScopeStack,
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
// ScopedExecutorOptions — read chain + explicit write target.
//
// `read` is innermost-first: `[user, org]` means per-user rows shadow
// per-org rows on id collision. `writeScopeId`, when set, routes writes
// to a specific scope in the chain. When omitted the innermost scope
// is the write target (the natural default — users "own" their own
// writes). The cloud HTTP edge uses the URL's `:scopeId` path param to
// select the write target so `POST /scopes/<orgId>/secrets` writes at
// the org scope while `POST /scopes/<userId>/secrets` writes at the
// user scope.
// ---------------------------------------------------------------------------

export interface ScopedExecutorOptions {
  readonly read: readonly {
    readonly id: string;
    readonly name: string;
  }[];
  readonly writeScopeId?: string;
}

export const createScopedExecutor = (options: ScopedExecutorOptions) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;

    const plugins = createOrgPlugins();
    const schema = collectSchemas(plugins);
    const adapter = makePostgresAdapter({ db, schema });
    const blobs = makePostgresBlobStore({ db });

    if (options.read.length === 0) {
      return yield* Effect.die(
        new Error("createScopedExecutor requires at least one scope in `read`"),
      );
    }

    const read = options.read.map(
      (s) =>
        new Scope({
          id: ScopeId.make(s.id),
          name: s.name,
          createdAt: new Date(),
        }),
    );
    // Default write = innermost (first) scope. When the caller specifies
    // a write target it must appear in the read chain — writing at a
    // scope the caller can't read is a wiring bug.
    const write = options.writeScopeId
      ? read.find((s) => s.id === options.writeScopeId)
      : read[0];
    if (!write) {
      return yield* Effect.die(
        new Error(
          `writeScopeId ${options.writeScopeId} is not in the read chain`,
        ),
      );
    }
    const scope = new ScopeStack({ read, write });

    // The executor surface returns raw `StorageFailure`; translation to
    // the opaque `InternalError({ traceId })` happens at the HTTP edge
    // via `withCapture` (see `api/protected-layers.ts`). That's
    // where `ErrorCaptureLive` (Sentry) gets wired in.
    return yield* createExecutor({ scope, adapter, blobs, plugins });
  });
