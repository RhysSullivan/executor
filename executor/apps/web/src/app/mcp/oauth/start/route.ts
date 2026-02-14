import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Result } from "better-result";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { getExternalOrigin, isExternalHttps } from "@/lib/mcp-oauth-request";
import { parseMcpSourceUrl } from "@/lib/mcp-oauth-url";
import {
  buildPendingCookieName,
  createOAuthState,
  encodePendingCookieValue,
  encodePopupResultCookieValue,
  MCP_OAUTH_RESULT_COOKIE,
  McpPopupOAuthProvider,
  type McpOAuthPopupResult,
} from "@/lib/mcp-oauth-provider";

function popupResultRedirect(request: NextRequest, payload: McpOAuthPopupResult): NextResponse {
  const externalOrigin = getExternalOrigin(request);
  const response = NextResponse.redirect(`${externalOrigin}/mcp/oauth/complete`);
  response.cookies.set({
    name: MCP_OAUTH_RESULT_COOKIE,
    value: encodePopupResultCookieValue(payload),
    httpOnly: true,
    secure: isExternalHttps(request),
    sameSite: "lax",
    maxAge: 2 * 60,
    path: "/",
  });
  return response;
}

function badPopupResponse(request: NextRequest, message: string): NextResponse {
  return popupResultRedirect(request, { ok: false, error: message });
}

function resultErrorMessage(error: unknown, fallback: string): string {
  const cause = typeof error === "object" && error && "cause" in error
    ? (error as { cause?: unknown }).cause
    : error;
  if (cause instanceof Error && cause.message.trim()) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.trim()) {
    return cause;
  }
  return fallback;
}

export async function GET(request: NextRequest) {
  const sourceUrlRaw = request.nextUrl.searchParams.get("sourceUrl")?.trim() ?? "";
  if (!sourceUrlRaw) {
    return badPopupResponse(request, "Missing sourceUrl");
  }

  const sourceUrlResult = parseMcpSourceUrl(sourceUrlRaw);
  if (!sourceUrlResult.isOk()) {
    return badPopupResponse(request, resultErrorMessage(sourceUrlResult.error, "Invalid sourceUrl"));
  }
  const sourceUrl = sourceUrlResult.value;

  const state = createOAuthState();
  const redirectUrl = `${getExternalOrigin(request)}/mcp/oauth/callback`;
  const provider = new McpPopupOAuthProvider({
    redirectUrl,
    state,
  });

  const authResult = await Result.tryPromise(() => auth(provider, { serverUrl: sourceUrl }));
  if (!authResult.isOk()) {
    return badPopupResponse(request, resultErrorMessage(authResult.error, "Failed to start OAuth flow"));
  }

  if (authResult.value === "AUTHORIZED") {
    const tokens = provider.getTokens();
    const accessToken = tokens?.access_token?.trim() ?? "";
    if (!accessToken) {
      return badPopupResponse(request, "OAuth flow completed without an access token");
    }
    return popupResultRedirect(request, {
      ok: true,
      sourceUrl: sourceUrl.toString(),
      accessToken,
      refreshToken: tokens?.refresh_token,
      scope: tokens?.scope,
      expiresIn: typeof tokens?.expires_in === "number" ? tokens.expires_in : undefined,
    });
  }

  const authorizationUrl = provider.getAuthorizationUrl();
  if (!authorizationUrl) {
    return badPopupResponse(request, "Server did not request an OAuth authorization step");
  }

  const pendingCookie = encodePendingCookieValue(provider.toPending(sourceUrl.toString()));
  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set({
    name: buildPendingCookieName(state),
    value: pendingCookie,
    httpOnly: true,
    secure: isExternalHttps(request),
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  return response;
}
