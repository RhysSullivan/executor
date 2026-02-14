import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  buildPendingCookieName,
  decodePendingCookieValue,
  McpPopupOAuthProvider,
  oauthPopupResultHtml,
} from "@/lib/mcp-oauth-provider";

function popupHtmlResponse(payload: {
  ok: boolean;
  sourceUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  scope?: string;
  expiresIn?: number;
  error?: string;
}): NextResponse {
  return new NextResponse(oauthPopupResultHtml(payload), {
    status: payload.ok ? 200 : 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  const state = request.nextUrl.searchParams.get("state")?.trim() ?? "";
  const error = request.nextUrl.searchParams.get("error")?.trim();

  if (!state) {
    return popupHtmlResponse({ ok: false, error: "Missing OAuth state" });
  }

  const cookieName = buildPendingCookieName(state);
  const rawPending = request.cookies.get(cookieName)?.value;
  const pending = rawPending ? decodePendingCookieValue(rawPending) : null;

  if (!pending) {
    const response = popupHtmlResponse({ ok: false, error: "OAuth session expired. Try connecting again." });
    response.cookies.delete(cookieName);
    return response;
  }

  if (error) {
    const response = popupHtmlResponse({ ok: false, error: `OAuth error: ${error}` });
    response.cookies.delete(cookieName);
    return response;
  }

  if (!code) {
    const response = popupHtmlResponse({ ok: false, error: "Missing OAuth authorization code" });
    response.cookies.delete(cookieName);
    return response;
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(pending.sourceUrl);
  } catch {
    const response = popupHtmlResponse({ ok: false, error: "Invalid MCP source URL" });
    response.cookies.delete(cookieName);
    return response;
  }

  const provider = new McpPopupOAuthProvider({
    redirectUrl: pending.redirectUrl,
    state: pending.state,
    codeVerifier: pending.codeVerifier,
    clientInformation: pending.clientInformation,
  });

  try {
    await auth(provider, {
      serverUrl: sourceUrl,
      authorizationCode: code,
    });
  } catch (finishError) {
    const response = popupHtmlResponse({
      ok: false,
      error: finishError instanceof Error ? finishError.message : "Failed to finish OAuth",
    });
    response.cookies.delete(cookieName);
    return response;
  }

  const tokens = provider.getTokens();
  const accessToken = tokens?.access_token?.trim() ?? "";
  if (!accessToken) {
    const response = popupHtmlResponse({ ok: false, error: "OAuth completed without an access token" });
    response.cookies.delete(cookieName);
    return response;
  }

  const response = popupHtmlResponse({
    ok: true,
    sourceUrl: pending.sourceUrl,
    accessToken,
    refreshToken: tokens?.refresh_token,
    scope: tokens?.scope,
    expiresIn: typeof tokens?.expires_in === "number" ? tokens.expires_in : undefined,
  });
  response.cookies.delete(cookieName);
  return response;
}
