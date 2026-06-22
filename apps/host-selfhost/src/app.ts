import { HttpApiSwagger } from "effect/unstable/httpapi";
import { HttpEffect, HttpRouter } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { composePluginApi, ExecutorApp, textFailureStrategy } from "@executor-js/api/server";

import { runSqliteDataMigrations } from "@executor-js/sdk";

import { resolveAuthProviders } from "./auth";
import { selfHostDataMigrations } from "./db/data-migrations";
import { makeSelfHostAdminApiLayer } from "./admin/handlers";
import { makeSelfHostSystemApiLayer } from "./system/handlers";
import { selfHostAccountMiddleware } from "./account";
import { loadConfig, SELF_HOST_NAMESPACE, SELF_HOST_SCHEMA_VERSION } from "./config";
import { createSelfHostDb, SelfHostDb, SelfHostDbProvider } from "./db/self-host-db";
import {
  SelfHostCodeExecutorProvider,
  SelfHostHostConfig,
  SelfHostPluginsProvider,
} from "./execution";
import { makeSelfHostMcpSeams } from "./mcp";
import { selfHostPlugins } from "./plugins";
import { ErrorCaptureLive } from "./observability";

// ===========================================================================
// The self-hosted Executor app, as ONE `ExecutorApp.make` call.
//
// The whole scenario in 60 seconds: Better Auth (cookie/bearer/api-key identity
// + /api/auth handler + account API + MCP OAuth) over a libSQL file, QuickJS
// in-process code execution, in-process MCP, console error capture, Swagger at
// /docs — and NO billing (the cloud `extensions.services` + /autumn route are
// simply absent). `diff` against the cloud app is the entire product difference.
//
// `ExecutorApp.make` owns the assembly (execution-stack middleware wrapping the
// protected API, the MCP envelope, the account API on the /api-prefixed router,
// the extension routes, provideMerge(boot)). This file's job is the eager async
// boot + slotting self-host's seam Layers into the named slots.
//
// Built eagerly (async) so the DB connection, schema migration, and Better Auth
// org/admin seeding happen at boot — fail fast on misconfig. The DB is opened
// ONCE and shared (Layer.succeed) by the per-request executor, Better Auth, and
// the MCP session store.
// ===========================================================================

export interface MakeSelfHostAppOptions {
  /** Override the SQLite path (tests point at a throwaway file). */
  readonly dbPath?: string;
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

// Server-rendered verification page for the CLI device flow. It binds the
// signed-in user to the pending code (GET /api/auth/device) and approves/denies
// it (POST /api/auth/device/approve|deny) via same-origin fetches carrying the
// session cookie, so the human just confirms the code and clicks Authorize.
const renderDevicePage = (userCode: string): string => {
  const code = JSON.stringify(userCode);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize device · Executor</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0b0b0c; color: #e7e7ea;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { background: #161618; border: 1px solid #2a2a2e; border-radius: 12px; padding: 32px;
          width: 360px; text-align: center; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { color: #a1a1aa; font-size: 14px; margin: 8px 0 20px; }
  .code { font-family: ui-monospace, monospace; font-size: 28px; letter-spacing: 4px;
          background: #0b0b0c; border: 1px solid #2a2a2e; border-radius: 8px; padding: 12px; margin: 12px 0; }
  button { font: inherit; border: 0; border-radius: 8px; padding: 10px 16px; cursor: pointer; margin: 4px; }
  .approve { background: #5b5bd6; color: white; }
  .deny { background: transparent; color: #a1a1aa; border: 1px solid #2a2a2e; }
  a { color: #8b8bf0; }
</style>
</head>
<body>
<div class="card" id="card">
  <h1>Authorize this device</h1>
  <p>Confirm the code shown in your terminal.</p>
  <div class="code">${escapeHtml(userCode)}</div>
  <div id="actions" hidden>
    <button class="approve" id="approve">Authorize device</button>
    <button class="deny" id="deny">Deny</button>
  </div>
  <p id="status">Checking your session…</p>
</div>
<script>
  const userCode = ${code};
  const card = document.getElementById("card");
  const actions = document.getElementById("actions");
  const status = document.getElementById("status");
  const done = (msg) => { actions.hidden = true; status.textContent = msg; };
  const post = (path) => fetch("/api/auth/device/" + path, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
  (async () => {
    // Bind the signed-in user to the pending code.
    const bound = await fetch("/api/auth/device?user_code=" + encodeURIComponent(userCode), {
      credentials: "include", headers: { accept: "application/json" },
    }).then((r) => r.ok).catch(() => false);
    if (!bound) {
      status.innerHTML = 'Sign in to this Executor first, then reopen this link. <a href="/login">Sign in</a>';
      return;
    }
    actions.hidden = false;
    status.textContent = "";
    document.getElementById("approve").onclick = async () => {
      done((await post("approve")).ok ? "Device approved. Return to your terminal." : "Could not approve. Try again.");
    };
    document.getElementById("deny").onclick = async () => {
      await post("deny"); done("Request denied. You can close this window.");
    };
  })();
</script>
</body>
</html>`;
};

export const makeSelfHostApp = async (options: MakeSelfHostAppOptions = {}) => {
  const config = loadConfig();

  // ---- eager async boot: the shared libSQL handle -----------------------
  const dbHandle = await createSelfHostDb({
    path: options.dbPath ?? config.dbPath,
    namespace: SELF_HOST_NAMESPACE,
    version: SELF_HOST_SCHEMA_VERSION,
  });

  // Boot-time data migrations: each registry entry runs once and is stamped
  // in the `data_migration` ledger; stamped entries are skipped without
  // touching the data.
  await Effect.runPromise(runSqliteDataMigrations(dbHandle.client, selfHostDataMigrations));

  // ---- auth providers ---------------------------------------------------
  // Better Auth: cookie/bearer/api-key identity + /api/auth handler + account
  // API + MCP OAuth seam, all over the shared libSQL handle.
  const { identityLayer, authHandler, betterAuth } = await resolveAuthProviders(dbHandle);

  // ---- the in-process MCP serving seams (+ shutdown hook) ----------------
  // Pass the pinned public origin so browser-approval URLs are reachable behind
  // a reverse proxy (not the internal 127.0.0.1 bind from the request URL).
  const mcp = makeSelfHostMcpSeams(dbHandle, betterAuth, config.webBaseUrl);

  // CLI device-login discovery (`executor login`). Points the CLI at Better
  // Auth's device endpoints; `requestFormat: "json"` because those endpoints
  // only accept JSON (unlike WorkOS's form-encoded ones). The issued token is a
  // Better Auth session that `bearer()` accepts on the /api/* plane.
  const cliLoginHandler = HttpEffect.fromWebHandler(
    async () =>
      new Response(
        JSON.stringify({
          provider: "better-auth",
          deviceAuthorizationEndpoint: `${config.webBaseUrl}/api/auth/device/code`,
          tokenEndpoint: `${config.webBaseUrl}/api/auth/device/token`,
          clientId: "executor-cli",
          requestFormat: "json",
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );

  // The verification page the device flow's verification_uri points at. Binds
  // the signed-in user to the pending code and approves/denies it via Better
  // Auth's device endpoints (same-origin, with the session cookie).
  const devicePageHandler = HttpEffect.fromWebHandler(async (request) => {
    const userCode = new URL(request.url).searchParams.get("user_code") ?? "";
    return new Response(renderDevicePage(userCode), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  const { appLayer, toWebHandler } = ExecutorApp.make({
    plugins: selfHostPlugins,
    providers: {
      identity: identityLayer,
      account: selfHostAccountMiddleware(betterAuth),
      db: SelfHostDbProvider,
      engine: { codeExecutor: SelfHostCodeExecutorProvider }, // decorator defaults to no-op (no metering)
      mcp: { auth: mcp.auth, sessions: mcp.sessions, reporter: mcp.reporter },
      plugins: { provider: SelfHostPluginsProvider, config: SelfHostHostConfig },
      errorCapture: ErrorCaptureLive,
    },
    extensions: {
      routes: [
        // CLI device-login discovery, must precede the /api/auth/* wildcard
        // below (Better Auth would otherwise 404 it).
        HttpRouter.add("GET", "/api/auth/cli-login", cliLoginHandler),
        // The device-flow verification page (verification_uri).
        HttpRouter.add("GET", "/device", devicePageHandler),
        // Better Auth owns the rest of /api/auth/*, the full path reaches it.
        HttpRouter.add("*", "/api/auth/*", HttpEffect.fromWebHandler(authHandler)),
        // Browser approval of paused MCP executions: the console resume page
        // reads paused detail (GET) and records the decision (POST .../resume),
        // session-cookie-gated, delegating to the in-process MCP store.
        HttpRouter.add("*", "/api/mcp-sessions/*", HttpEffect.fromWebHandler(mcp.approvalHandler)),
        // App-local admin (invite-code) API, served under /api/admin/*.
        makeSelfHostAdminApiLayer({ betterAuth, db: dbHandle, mountPrefix: "/api" }),
        // Public system API: /api/health + /api/setup-status (unauthenticated).
        makeSelfHostSystemApiLayer({ betterAuth, db: dbHandle, mountPrefix: "/api" }),
        // Swagger UI at /docs, over the /api-prefixed spec (matches the served paths).
        HttpApiSwagger.layer(composePluginApi(selfHostPlugins).prefix("/api"), { path: "/docs" }),
      ],
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    // The boot-scoped context provideMerge'd under everything: the long-lived DB
    // handle (read by the DbProvider seam, Better Auth, and the MCP store) + the
    // resolved identity (captured once by the execution middleware + MCP auth).
    boot: Layer.merge(Layer.succeed(SelfHostDb)(dbHandle), identityLayer),
  });

  return {
    // Every route requirement is provided (the seams + boot resolve to nothing
    // residual), so the assembled app is a `Layer<never>` — the precise shape
    // `serve.ts` binds to the Bun socket. `make` types its `appLayer` loosely
    // (it can't prove each host's resolution); self-host narrows it here.
    AppLayer: appLayer as Layer.Layer<never>,
    toWebHandler,
    closeDb: async () => {
      await mcp.close();
      await dbHandle.close();
    },
  };
};

export interface SelfHostApiHandler {
  /** Unified web handler: serves /api/*, /api/auth/*, /mcp, and /docs. */
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

// Web-handler binding of `AppLayer` — used by tests (and the same shape cloud
// uses for Workers). The self-host server (serve.ts) binds `AppLayer` to a
// listening socket instead. We wrap `dispose` to also close the DB / MCP store.
export const makeSelfHostApiHandler = async (
  options: MakeSelfHostAppOptions = {},
): Promise<SelfHostApiHandler> => {
  const { toWebHandler, closeDb } = await makeSelfHostApp(options);
  const web = toWebHandler();
  return {
    handler: web.handler,
    dispose: async () => {
      await web.dispose();
      await closeDb();
    },
  };
};
