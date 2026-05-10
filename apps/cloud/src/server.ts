import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";
import { Effect } from "effect";

import { handleApiRequest } from "./api";
import { mcpFetch } from "./mcp";
import { handleSentryTunnelRequest } from "./sentry-tunnel";

const sentryOptions = (env: Env) => ({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0,
  enableLogs: true,
  sendDefaultPii: true,
  // Effect owns tracing through services/telemetry.ts. Keep Sentry limited to
  // error/log capture so it doesn't install a competing global OTEL provider.
  skipOpenTelemetrySetup: true,
  // Our DO methods (init/handleRequest/alarm) live on the prototype, not on
  // the instance. Sentry's default DO auto-wrap only visits own properties,
  // which misses prototype methods — so errors thrown inside init() never
  // reach Sentry. This flag opts into prototype-method instrumentation.
  instrumentPrototypeMethods: true,
});

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------

const MARKETING_PATHS = ["/home", "/setup", "/privacy", "/terms", "/_astro"];
const POSTHOG_INGEST_HOST = "us.i.posthog.com";
const POSTHOG_ASSETS_HOST = "us-assets.i.posthog.com";
const POSTHOG_PROXY_PATH = `/api/${(import.meta.env.VITE_PUBLIC_ANALYTICS_PATH ?? "a").replace(
  /^\/+|\/+$/g,
  "",
)}`;

const isMarketingPath = (pathname: string) =>
  MARKETING_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) || null : null;
};

const maybeMarketing = (request: Request, env: Env, pathname: string) => {
  const host = new URL(request.url).hostname;
  if (host !== "executor.sh") return undefined;

  const shouldProxyToMarketing =
    isMarketingPath(pathname) ||
    (pathname === "/" && !parseCookie(request.headers.get("cookie"), "wos-session"));

  if (!shouldProxyToMarketing) return undefined;

  const url = new URL(request.url);
  if (pathname === "/home") {
    url.pathname = "/";
  }
  return env.MARKETING.fetch(new Request(url, request));
};

const maybePostHog = (request: Request, pathname: string) => {
  if (pathname !== POSTHOG_PROXY_PATH && !pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) {
    return undefined;
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
};

const platformFetch = async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const marketing = maybeMarketing(request, env, pathname);
  if (marketing) return marketing;

  const mcp = await mcpFetch(request, env);
  if (mcp) return mcp;

  if (pathname === "/api/sentry-tunnel" && request.method === "POST") {
    if (!env.SENTRY_DSN) return new Response(null, { status: 204 });
    return Effect.runPromise(handleSentryTunnelRequest(request, env.SENTRY_DSN));
  }

  const posthog = maybePostHog(request, pathname);
  if (posthog) return posthog;

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    url.pathname = url.pathname.replace(/^\/api/, "");
    return handleApiRequest(new Request(url, request), env);
  }

  return handler.fetch(request);
};

const dispatchHandler = {
  fetch: platformFetch,
};

export default Sentry.withSentry(sentryOptions, dispatchHandler);
