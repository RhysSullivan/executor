import { env } from "cloudflare:workers";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { handleApiRequest } from "./api";
import { mcpFetch } from "./mcp";

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
  async ({ pathname, request, next }) => {
    if (pathname !== "/api/sentry-tunnel" || request.method !== "POST") {
      return next();
    }

    const configuredDsn = (env as { SENTRY_DSN?: string }).SENTRY_DSN;
    if (!configuredDsn) return new Response(null, { status: 204 });

    try {
      const envelope = await request.text();
      const firstLine = envelope.slice(0, envelope.indexOf("\n"));
      const header = JSON.parse(firstLine) as { dsn?: string };
      if (!header.dsn) return new Response("missing dsn", { status: 400 });

      const envelopeDsn = new URL(header.dsn);
      const ourDsn = new URL(configuredDsn);
      if (envelopeDsn.host !== ourDsn.host || envelopeDsn.pathname !== ourDsn.pathname) {
        return new Response("dsn mismatch", { status: 400 });
      }

      const projectId = envelopeDsn.pathname.replace(/^\//, "");
      const ingestUrl = `https://${envelopeDsn.host}/api/${projectId}/envelope/`;
      return fetch(ingestUrl, {
        method: "POST",
        body: envelope,
        headers: { "Content-Type": "application/x-sentry-envelope" },
      });
    } catch {
      return new Response("bad envelope", { status: 400 });
    }
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
    marketingMiddleware,
    mcpRequestMiddleware,
    sentryTunnelMiddleware,
    apiRequestMiddleware,
  ],
}));
