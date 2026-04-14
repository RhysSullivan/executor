import { env } from "cloudflare:workers";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { handleApiRequest } from "./api";
import { handleMcpRequest } from "./mcp";

// ---------------------------------------------------------------------------
// Marketing routes — proxied to the marketing worker via service binding
// ---------------------------------------------------------------------------

const MARKETING_PATHS = ["/home", "/setup", "/api/detect", "/_astro"];

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
      const response = await handleMcpRequest(request);
      if (response) return response;
    }
    return next();
  },
);

// ---------------------------------------------------------------------------
// API middleware — routes /api/* to the Effect HTTP layer
//
// `/api/o/:orgSlug/*` is the org-scoped namespace for the protected API
// (tools, sources, secrets, executions). We peel the slug off the front of
// the path and stash it on an internal `x-executor-org-slug` header, then
// forward the inner path to the Effect router. `lookupOrgForRequest` reads
// the header when authorizing — falling back to the session cookie when no
// header is present (auth endpoints, Autumn, OrgApi).
//
// We deliberately use `/o/` (not `/org/`) to avoid colliding with the
// existing OrgApi mount at `/api/org/*`.
// ---------------------------------------------------------------------------

const ORG_SCOPED_PATH = /^\/o\/([^/]+)(\/.*)?$/;

const apiRequestMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (pathname !== "/api" && !pathname.startsWith("/api/")) return next();

    const url = new URL(request.url);
    let innerPath = url.pathname.replace(/^\/api/, "") || "/";

    const headers = new Headers(request.headers);
    const scoped = innerPath.match(ORG_SCOPED_PATH);
    if (scoped) {
      const [, orgSlug, rest] = scoped;
      headers.set("x-executor-org-slug", orgSlug);
      innerPath = rest ?? "/";
    }

    url.pathname = innerPath;
    return handleApiRequest(
      new Request(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: request.redirect,
        // Cloudflare Workers requires `duplex: "half"` when forwarding a
        // streaming body; tolerate runtimes that don't know the option.
        ...(request.body ? { duplex: "half" } : {}),
      } as RequestInit),
    );
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [marketingMiddleware, mcpRequestMiddleware, apiRequestMiddleware],
}));
