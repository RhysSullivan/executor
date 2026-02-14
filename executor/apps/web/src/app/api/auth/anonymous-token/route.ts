import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function toSiteUrl(convexUrl?: string): string | null {
  if (!convexUrl) {
    return null;
  }

  try {
    const parsed = new URL(convexUrl);
    if (parsed.hostname.endsWith(".convex.cloud")) {
      parsed.hostname = parsed.hostname.replace(/\.convex\.cloud$/, ".convex.site");
    }
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function resolveConvexSiteUrl(): string | null {
  return toSiteUrl(
    process.env.EXECUTOR_WEB_CONVEX_SITE_URL
      ?? process.env.NEXT_PUBLIC_CONVEX_SITE_URL
      ?? process.env.CONVEX_SITE_URL
      ?? process.env.EXECUTOR_WEB_CONVEX_URL
      ?? process.env.NEXT_PUBLIC_CONVEX_URL
      ?? process.env.CONVEX_URL,
  );
}

function noStoreJson(payload: unknown, status: number): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

export async function POST(request: NextRequest) {
  const convexSiteUrl = resolveConvexSiteUrl();
  if (!convexSiteUrl) {
    return noStoreJson({ error: "Convex site URL is not configured" }, 500);
  }

  let body: { actorId?: string } = {};
  try {
    const parsed = await request.json() as { actorId?: unknown };
    if (typeof parsed.actorId === "string" && parsed.actorId.trim().length > 0) {
      body.actorId = parsed.actorId.trim();
    }
  } catch {
    body = {};
  }

  const response = await fetch(`${convexSiteUrl}/auth/anonymous/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: text || "Anonymous token endpoint returned invalid JSON" };
  }

  return noStoreJson(payload, response.status);
}
