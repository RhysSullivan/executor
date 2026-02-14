import type { NextRequest } from "next/server";
import { parse as parseDomain } from "tldts";

const MAX_REDIRECTS = 4;

function isAllowedFaviconUrl(url: URL): boolean {
  if (url.protocol !== "https:") {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname === "icons.duckduckgo.com") {
    return url.pathname.startsWith("/ip3/") && url.pathname.endsWith(".ico");
  }

  if (hostname === "www.google.com") {
    return url.pathname === "/s2/favicons";
  }

  if (/^t\d+\.gstatic\.com$/.test(hostname)) {
    return url.pathname === "/faviconV2";
  }

  if (url.pathname !== "/favicon.ico" || url.search.length > 0) {
    return false;
  }

  const parsed = parseDomain(hostname);
  return Boolean(parsed.isIcann) && !parsed.isIp;
}

async function fetchFaviconWithRedirects(initialUrl: URL): Promise<Response> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        accept: "image/*,*/*;q=0.8",
        "user-agent": "executor-web-favicon-proxy/1.0",
      },
      cache: "force-cache",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return response;
      }

      const nextUrl = new URL(location, currentUrl);
      if (!isAllowedFaviconUrl(nextUrl)) {
        return new Response("Blocked redirect target", { status: 400 });
      }

      currentUrl = nextUrl;
      continue;
    }

    return response;
  }

  return new Response("Too many redirects", { status: 508 });
}

export async function GET(request: NextRequest): Promise<Response> {
  const rawUrl = request.nextUrl.searchParams.get("url")?.trim() ?? "";
  if (!rawUrl) {
    return new Response("Missing url", { status: 400 });
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(rawUrl);
  } catch {
    return new Response("Invalid url", { status: 400 });
  }

  if (!isAllowedFaviconUrl(upstreamUrl)) {
    return new Response("Blocked url", { status: 400 });
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchFaviconWithRedirects(upstreamUrl);
  } catch {
    return new Response("Failed to fetch favicon", { status: 502 });
  }

  const headers = new Headers();
  const contentType = upstreamResponse.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }
  headers.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers,
  });
}
