import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Result } from "better-result";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { getExternalOrigin, isExternalHttps } from "@/lib/mcp-oauth-request";
import { parseMcpSourceUrl } from "@/lib/mcp-oauth-url";
import {
  buildPendingCookieName,
  decodePendingCookieValue,
  encodePopupResultCookieValue,
  MCP_OAUTH_RESULT_COOKIE,
  McpPopupOAuthProvider,
  type McpOAuthPopupResult,
} from "@/lib/mcp-oauth-provider";

function popupResultRedirect(
  request: NextRequest,
  pendingCookieName: string | null,
  payload: McpOAuthPopupResult,
): NextResponse {
  const origin = getExternalOrigin(request);
  const response = NextResponse.redirect(`${origin}/mcp/oauth/complete`);
  response.cookies.set({
    name: MCP_OAUTH_RESULT_COOKIE,
    value: encodePopupResultCookieValue(payload),
    httpOnly: true,
    secure: isExternalHttps(request),
    sameSite: "lax",
    maxAge: 2 * 60,
    path: "/",
  });
  if (pendingCookieName) {
    response.cookies.delete(pendingCookieName);
  }
  return response;
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
  const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  const state = request.nextUrl.searchParams.get("state")?.trim() ?? "";
  const error = request.nextUrl.searchParams.get("error")?.trim();

  if (!state) {
    return popupResultRedirect(request, null, { ok: false, error: "Missing OAuth state" });
  }

  const cookieName = buildPendingCookieName(state);
  const rawPending = request.cookies.get(cookieName)?.value;
  const pending = rawPending ? decodePendingCookieValue(rawPending) : null;

  if (!pending) {
    return popupResultRedirect(request, cookieName, {
      ok: false,
      error: "OAuth session expired. Try connecting again.",
    });
  }

  if (error) {
    return popupResultRedirect(request, cookieName, { ok: false, error: `OAuth error: ${error}` });
  }

  if (!code) {
    return popupResultRedirect(request, cookieName, {
      ok: false,
      error: "Missing OAuth authorization code",
    });
  }

  const sourceUrlResult = parseMcpSourceUrl(pending.sourceUrl);
  if (!sourceUrlResult.isOk()) {
    return popupResultRedirect(request, cookieName, { ok: false, error: "Invalid MCP source URL" });
  }
  const sourceUrl = sourceUrlResult.value;

  const provider = new McpPopupOAuthProvider({
    redirectUrl: pending.redirectUrl,
    state: pending.state,
    codeVerifier: pending.codeVerifier,
    clientInformation: pending.clientInformation,
  });

  const authResult = await Result.tryPromise(() => auth(provider, {
      serverUrl: sourceUrl,
      authorizationCode: code,
    }));
  if (!authResult.isOk()) {
    return popupResultRedirect(request, cookieName, {
      ok: false,
      error: resultErrorMessage(authResult.error, "Failed to finish OAuth"),
    });
  }

  const tokens = provider.getTokens();
  const accessToken = tokens?.access_token?.trim() ?? "";
  if (!accessToken) {
    return popupResultRedirect(request, cookieName, {
      ok: false,
      error: "OAuth completed without an access token",
    });
  }

  return popupResultRedirect(request, cookieName, {
    ok: true,
    sourceUrl: pending.sourceUrl,
    accessToken,
    refreshToken: tokens?.refresh_token,
    scope: tokens?.scope,
    expiresIn: typeof tokens?.expires_in === "number" ? tokens.expires_in : undefined,
  });
}
