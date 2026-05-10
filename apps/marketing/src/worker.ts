import type * as Cloudflare from "alchemy/Cloudflare";
import type { marketingWorker } from "../infra/stack";

type MarketingBindings = Cloudflare.InferEnv<ReturnType<typeof marketingWorker>>;

type MarketingEnv = {
  PUBLIC_ANALYTICS_PATH?: string;
} & MarketingBindings;

const POSTHOG_INGEST_HOST = "us.i.posthog.com";
const POSTHOG_ASSETS_HOST = "us-assets.i.posthog.com";

const posthogProxyPath = (env: MarketingEnv) =>
  `/api/${(env.PUBLIC_ANALYTICS_PATH ?? "a").replace(/^\/+|\/+$/g, "")}`;

const isPosthogProxyRequest = (pathname: string, proxyPath: string) =>
  pathname === proxyPath || pathname.startsWith(`${proxyPath}/`);

const proxyPosthog = (request: Request, pathname: string, proxyPath: string) => {
  const url = new URL(request.url);
  url.hostname = pathname.startsWith(`${proxyPath}/static/`)
    ? POSTHOG_ASSETS_HOST
    : POSTHOG_INGEST_HOST;
  url.protocol = "https:";
  url.port = "";
  url.pathname = pathname.slice(proxyPath.length) || "/";

  const upstream = new Request(url, request);
  upstream.headers.delete("cookie");
  return fetch(upstream);
};

export default {
  fetch: (request: Request, env: MarketingEnv) => {
    const { pathname } = new URL(request.url);

    const proxyPath = posthogProxyPath(env);
    if (isPosthogProxyRequest(pathname, proxyPath)) {
      return proxyPosthog(request, pathname, proxyPath);
    }

    return env.ASSETS.fetch(request);
  },
};
