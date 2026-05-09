import { env } from "cloudflare:workers";
import postgres from "postgres";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { Effect } from "effect";
import { handleApiRequest } from "./api";
import { mcpFetch } from "./mcp";
import { handleSentryTunnelRequest } from "./sentry-tunnel";
import { resolveConnectionString } from "./services/db";

// ---------------------------------------------------------------------------
// Health/readiness endpoints — intentionally handled before app/API routing
// so deploy automation and Cloudflare monitors can verify the worker without
// booting the full React/API request path. `/healthz` is public and cheap;
// `/readyz` is dependency-aware and may be protected by READINESS_TOKEN.
// ---------------------------------------------------------------------------

const jsonResponse = (payload: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });

const currentBuild = () => ({
  service: "executor-cloud",
  status: "ok",
  version: env.EXECUTOR_BUILD_VERSION ?? "dev",
  commit: env.EXECUTOR_BUILD_SHA ?? null,
});

type DatabaseCheck = { ok: true } | { ok: false; error: string };

const checkDatabase = (): Effect.Effect<DatabaseCheck, never, never> => {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    return Effect.succeed({ ok: false, error: "database connection string is not configured" });
  }

  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 5,
    connect_timeout: 5,
    fetch_types: false,
    prepare: false,
    onnotice: () => undefined,
  });

  return Effect.tryPromise({
    try: () => sql`select 1`,
    catch: (cause) => cause,
  }).pipe(
    Effect.as({ ok: true } as const),
    Effect.catch((cause: unknown) =>
      Effect.sync(() => {
        console.error("[readyz] database check failed", cause);
        return { ok: false, error: "database check failed" } as const;
      }),
    ),
    Effect.ensuring(
      Effect.promise(() =>
        sql.end({ timeout: 0 }).then(
          () => undefined,
          () => undefined,
        ),
      ),
    ),
  );
};

const requiredSecretChecks = () => ({
  WORKOS_API_KEY: Boolean(env.WORKOS_API_KEY),
  WORKOS_CLIENT_ID: Boolean(env.WORKOS_CLIENT_ID),
  WORKOS_COOKIE_PASSWORD: Boolean(env.WORKOS_COOKIE_PASSWORD),
  AUTUMN_SECRET_KEY: Boolean(env.AUTUMN_SECRET_KEY),
});

const healthMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (pathname === "/healthz") {
      return jsonResponse(currentBuild());
    }

    if (pathname !== "/readyz") return next();

    const readinessToken = env.READINESS_TOKEN;
    if (readinessToken) {
      const header = request.headers.get("x-readiness-token");
      if (header !== readinessToken) {
        return jsonResponse({ ...currentBuild(), status: "unauthorized" }, { status: 401 });
      }
    }

    const database = await Effect.runPromise(checkDatabase());
    const secrets = requiredSecretChecks();
    const secretsOk = Object.values(secrets).every(Boolean);
    const ok = database.ok && secretsOk;

    return jsonResponse(
      {
        ...currentBuild(),
        status: ok ? "ready" : "not_ready",
        checks: { database, secrets },
      },
      { status: ok ? 200 : 503 },
    );
  },
);

// ---------------------------------------------------------------------------
// Marketing routes — proxied to the marketing worker via service binding
// ---------------------------------------------------------------------------

const MARKETING_PATHS = ["/home", "/setup", "/privacy", "/terms", "/api/detect", "/_astro"];

const isMarketingPath = (pathname: string) =>
  MARKETING_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const getMarketingWorker = () => env.MARKETING as { fetch: typeof fetch } | undefined;

const marketingMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    // Only proxy to the marketing worker on the production domain. In local
    // dev we don't run `executor-marketing`, so unauthenticated visits fall
    // through to the cloud app's routes (which show the sign-in page).
    const host = new URL(request.url).hostname;
    if (host !== "executor.sh") return next();

    const shouldProxyToMarketing =
      isMarketingPath(pathname) ||
      (pathname === "/" && !parseCookie(request.headers.get("cookie"), "wos-session"));

    if (!shouldProxyToMarketing) return next();

    const marketing = getMarketingWorker();
    if (!marketing) return next();

    const url = new URL(request.url);
    // Rewrite /home to / so marketing worker serves its homepage
    if (pathname === "/home") {
      url.pathname = "/";
    }
    return marketing.fetch(new Request(url, request));
  },
);

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) || null : null;
};

// ---------------------------------------------------------------------------
// MCP middleware — routes /mcp and /.well-known/* to the MCP handler
// ---------------------------------------------------------------------------

const mcpRequestMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (pathname === "/mcp" || pathname.startsWith("/.well-known/")) {
      const response = await mcpFetch(request);
      if (response) return response;
    }
    return next();
  },
);

// ---------------------------------------------------------------------------
// Sentry tunnel — the browser SDK POSTs envelopes to /api/sentry-tunnel
// (configured in routes/__root.tsx) to dodge adblockers and CSP. We parse
// the envelope header to recover the DSN, validate against our own, and
// forward the body to Sentry's ingest endpoint. See
// https://docs.sentry.io/platforms/javascript/troubleshooting/#using-the-tunnel-option
// ---------------------------------------------------------------------------

const sentryTunnelMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (pathname !== "/api/sentry-tunnel" || request.method !== "POST") {
      return next();
    }

    const configuredDsn = (env as { SENTRY_DSN?: string }).SENTRY_DSN;
    if (!configuredDsn) return new Response(null, { status: 204 });

    return Effect.runPromise(handleSentryTunnelRequest(request, configuredDsn));
  },
);

// ---------------------------------------------------------------------------
// PostHog reverse proxy — the browser SDK targets a build-randomized
// first-party path and we forward to PostHog's ingest + asset hosts. Keeps
// events flowing past adblockers that match *.posthog.com. See
// https://posthog.com/docs/advanced/proxy/cloudflare
// ---------------------------------------------------------------------------

const POSTHOG_INGEST_HOST = "us.i.posthog.com";
const POSTHOG_ASSETS_HOST = "us-assets.i.posthog.com";
const POSTHOG_PROXY_PATH = `/api/${(import.meta.env.VITE_PUBLIC_ANALYTICS_PATH ?? "a").replace(
  /^\/+|\/+$/g,
  "",
)}`;

const posthogProxyMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (pathname !== POSTHOG_PROXY_PATH && !pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) {
      return next();
    }

    const url = new URL(request.url);
    url.hostname = pathname.startsWith(`${POSTHOG_PROXY_PATH}/static/`)
      ? POSTHOG_ASSETS_HOST
      : POSTHOG_INGEST_HOST;
    url.protocol = "https:";
    url.port = "";
    url.pathname = pathname.slice(POSTHOG_PROXY_PATH.length) || "/";

    const upstream = new Request(url, request);
    upstream.headers.delete("cookie");
    return fetch(upstream);
  },
);

// ---------------------------------------------------------------------------
// API middleware — routes /api/* to the Effect HTTP layer
// ---------------------------------------------------------------------------

const apiRequestMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(/^\/api/, "");
      return handleApiRequest(new Request(url, request));
    }
    return next();
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [
    healthMiddleware,
    marketingMiddleware,
    mcpRequestMiddleware,
    sentryTunnelMiddleware,
    posthogProxyMiddleware,
    apiRequestMiddleware,
  ],
}));
