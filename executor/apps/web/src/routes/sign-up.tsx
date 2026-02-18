import { createFileRoute } from "@tanstack/react-router";
import { ConvexHttpClient } from "convex/browser";
import { getAuthkit } from "@workos/authkit-tanstack-react-start";
import { api } from "@executor/database/convex/_generated/api";
import type { Id } from "@executor/database/convex/_generated/dataModel";
import { externalOriginFromRequest } from "@/lib/http/request-origin";
import { readOptionalQueryParam, readOptionalReferrerQueryParam } from "@/lib/http/query-params";
import { redirectResponse } from "@/lib/http/response";

const AUTHKIT_PASSTHROUGH_QUERY_KEYS = [
  "authorization_session_id",
  "redirect_uri",
  "state",
  "client_id",
];

function trim(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

const convexUrl =
  trim(process.env.EXECUTOR_WEB_CONVEX_URL)
  ?? trim(process.env.CONVEX_URL)
  ?? trim(process.env.VITE_CONVEX_URL);
const convexClient = convexUrl ? new ConvexHttpClient(convexUrl) : null;

function appendAuthkitPassthroughQueryParams(requestUrl: URL, authorizationUrl: string): string {
  const nextUrl = new URL(authorizationUrl);

  for (const key of AUTHKIT_PASSTHROUGH_QUERY_KEYS) {
    const value = requestUrl.searchParams.get(key);
    if (!value || value.trim().length === 0) {
      continue;
    }

    nextUrl.searchParams.set(key, value.trim());
  }

  return nextUrl.toString();
}

async function resolveOrganizationHint(requestUrl: URL): Promise<string | undefined> {
  const organizationHint = readOptionalQueryParam(requestUrl, [
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
    const workosOrganizationId = await convexClient.query(
      api.organizations.resolveWorkosOrganizationId,
      { organizationId: organizationHint as Id<"organizations"> },
    );
    return typeof workosOrganizationId === "string" ? workosOrganizationId : undefined;
  } catch {
    return undefined;
  }
}

async function handleSignUp(request: Request): Promise<Response> {
  if (!process.env.WORKOS_CLIENT_ID) {
    return redirectResponse("/");
  }

  const requestUrl = new URL(request.url);
  const oauthRedirectUri =
    readOptionalQueryParam(requestUrl, ["redirect_uri", "redirectUri"])
    ?? readOptionalReferrerQueryParam(request, ["redirect_uri", "redirectUri"]);
  const oauthState =
    readOptionalQueryParam(requestUrl, ["state"])
    ?? readOptionalReferrerQueryParam(request, ["state"]);
  const oauthClientId =
    readOptionalQueryParam(requestUrl, ["client_id", "clientId"])
    ?? readOptionalReferrerQueryParam(request, ["client_id", "clientId"]);
  const redirectUri = oauthRedirectUri ?? `${externalOriginFromRequest(request)}/callback`;
  const organizationId = await resolveOrganizationHint(requestUrl);
  const loginHint = readOptionalQueryParam(requestUrl, ["loginHint", "login_hint", "email"]);

  const authkit = await getAuthkit();
  const baseAuthorizationUrl = await authkit.getSignUpUrl({
    redirectUri,
    organizationId,
    loginHint,
    state: oauthState,
  });

  const authorizationUrl = appendAuthkitPassthroughQueryParams(requestUrl, baseAuthorizationUrl);
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

  return redirectResponse(finalUrl.toString());
}

export const Route = createFileRoute("/sign-up")({
  server: {
    handlers: {
      GET: ({ request }) => handleSignUp(request),
    },
  },
});
