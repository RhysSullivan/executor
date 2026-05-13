import type { MiddlewareHandler } from "astro";

// PostHog reverse proxy — the browser SDK targets a build-randomized
// first-party path and we forward to PostHog's ingest + asset hosts. Keeps
// events flowing past adblockers that match *.posthog.com. See
// https://posthog.com/docs/advanced/proxy/cloudflare

const POSTHOG_INGEST_HOST = "us.i.posthog.com";
const POSTHOG_ASSETS_HOST = "us-assets.i.posthog.com";
const POSTHOG_PROXY_PATH = `/api/${(import.meta.env.PUBLIC_ANALYTICS_PATH ?? "a").replace(
  /^\/+|\/+$/g,
  "",
)}`;

export const onRequest: MiddlewareHandler = async (context, next) => {
  const { pathname } = new URL(context.request.url);
  if (pathname !== POSTHOG_PROXY_PATH && !pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) {
    return next();
  }

  const url = new URL(context.request.url);
  url.hostname = pathname.startsWith(`${POSTHOG_PROXY_PATH}/static/`)
    ? POSTHOG_ASSETS_HOST
    : POSTHOG_INGEST_HOST;
  url.protocol = "https:";
  url.port = "";
  url.pathname = pathname.slice(POSTHOG_PROXY_PATH.length) || "/";

  const upstream = new Request(url, context.request);
  upstream.headers.delete("cookie");
  return fetch(upstream);
};
