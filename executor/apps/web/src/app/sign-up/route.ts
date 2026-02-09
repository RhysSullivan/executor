import type { NextRequest } from "next/server";
import { redirect } from "next/navigation";
import { ConvexHttpClient } from "convex/browser";

function getExternalOrigin(request: NextRequest) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  if (host && proto) {
    return `${proto}://${host}`;
  }
  return request.nextUrl.origin;
}

function readOptionalQueryParam(request: NextRequest, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = request.nextUrl.searchParams.get(key);
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readOptionalReferrerQueryParam(request: NextRequest, keys: string[]): string | undefined {
  const referrer = request.headers.get("referer");
  if (!referrer) {
    return undefined;
  }

  let referrerUrl: URL;
  try {
    referrerUrl = new URL(referrer);
  } catch {
    return undefined;
  }

  for (const key of keys) {
    const value = referrerUrl.searchParams.get(key);
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

const AUTHKIT_PASSTHROUGH_QUERY_KEYS = [
  "authorization_session_id",
  "redirect_uri",
  "state",
  "client_id",
];

function appendAuthkitPassthroughQueryParams(request: NextRequest, authorizationUrl: string): string {
  const nextUrl = new URL(authorizationUrl);

  for (const key of AUTHKIT_PASSTHROUGH_QUERY_KEYS) {
    const value = request.nextUrl.searchParams.get(key);
    if (!value || value.trim().length === 0) {
      continue;
    }
    nextUrl.searchParams.set(key, value.trim());
  }

  return nextUrl.toString();
}

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL;
const convexClient = convexUrl ? new ConvexHttpClient(convexUrl) : null;

async function resolveOrganizationHint(request: NextRequest): Promise<string | undefined> {
  const organizationHint = readOptionalQueryParam(request, [
    "organizationId",
    "organization_id",
    "orgId",
    "org_id",
  ]);

  if (!organizationHint) {
    return undefined;
  }

  if (organizationHint.startsWith("org_")) {
    return organizationHint;
  }

  if (!convexClient) {
    return undefined;
  }

  try {
    const workosOrganizationId = await (convexClient as any).query(
      "organizations:resolveWorkosOrganizationId",
      { organizationId: organizationHint },
    );
    return typeof workosOrganizationId === "string" ? workosOrganizationId : undefined;
  } catch {
    return undefined;
  }
}

export async function GET(request: NextRequest) {
  if (!process.env.WORKOS_CLIENT_ID) {
    return redirect("/");
  }

  const oauthRedirectUri =
    readOptionalQueryParam(request, ["redirect_uri", "redirectUri"])
    ?? readOptionalReferrerQueryParam(request, ["redirect_uri", "redirectUri"]);
  const oauthState =
    readOptionalQueryParam(request, ["state"])
    ?? readOptionalReferrerQueryParam(request, ["state"]);
  const oauthClientId =
    readOptionalQueryParam(request, ["client_id", "clientId"])
    ?? readOptionalReferrerQueryParam(request, ["client_id", "clientId"]);
  const redirectUri = oauthRedirectUri ?? `${getExternalOrigin(request)}/callback`;
  const organizationId = await resolveOrganizationHint(request);
  const loginHint = readOptionalQueryParam(request, ["loginHint", "login_hint", "email"]);

  const { getSignUpUrl } = await import("@workos-inc/authkit-nextjs");
  const baseAuthorizationUrl = await getSignUpUrl({
    redirectUri,
    organizationId,
    loginHint,
    state: oauthState,
  });
  const authorizationUrl = appendAuthkitPassthroughQueryParams(request, baseAuthorizationUrl);
  const finalUrl = new URL(authorizationUrl);

  if (oauthRedirectUri) {
    finalUrl.searchParams.set("redirect_uri", oauthRedirectUri);
  }
  if (oauthState) {
    finalUrl.searchParams.set("state", oauthState);
  }
  if (oauthClientId && oauthClientId.startsWith("client_")) {
    finalUrl.searchParams.set("client_id", oauthClientId);
  }

  return redirect(finalUrl.toString());
}
