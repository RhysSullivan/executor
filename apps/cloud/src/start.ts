import { createMiddleware, createStart } from "@tanstack/react-start";
import { handleApiRequest } from "./api";
import { cf } from "./env";

// ---------------------------------------------------------------------------
// Marketing routes — proxied to the marketing worker via service binding
// ---------------------------------------------------------------------------

const MARKETING_PATHS = ["/home", "/setup", "/api/detect", "/_astro", "/favicon.ico", "/favicon.svg"];

const isMarketingPath = (pathname: string) =>
  MARKETING_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const getMarketingWorker = () => cf.marketing as { fetch: typeof fetch } | undefined;

const marketingMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
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
  requestMiddleware: [marketingMiddleware, apiRequestMiddleware],
}));
