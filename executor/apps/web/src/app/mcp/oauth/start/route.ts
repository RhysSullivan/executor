import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  buildPendingCookieName,
  createOAuthState,
  encodePendingCookieValue,
  McpPopupOAuthProvider,
  oauthPopupResultHtml,
} from "@/lib/mcp-oauth-provider";

function getExternalOrigin(request: NextRequest): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  if (host && proto) {
    return `${proto}://${host}`;
  }
  return request.nextUrl.origin;
}

function badPopupResponse(message: string): NextResponse {
  return new NextResponse(oauthPopupResultHtml({ ok: false, error: message }), {
    status: 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function GET(request: NextRequest) {
  const sourceUrlRaw = request.nextUrl.searchParams.get("sourceUrl")?.trim() ?? "";
  if (!sourceUrlRaw) {
    return badPopupResponse("Missing sourceUrl");
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourceUrlRaw);
  } catch {
    return badPopupResponse("Invalid sourceUrl");
  }

  const state = createOAuthState();
  const redirectUrl = `${getExternalOrigin(request)}/mcp/oauth/callback`;
  const provider = new McpPopupOAuthProvider({
    redirectUrl,
    state,
  });

  let authResult: "AUTHORIZED" | "REDIRECT";
  try {
    authResult = await auth(provider, { serverUrl: sourceUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start OAuth flow";
    return badPopupResponse(message);
  }

  if (authResult === "AUTHORIZED") {
    const tokens = provider.getTokens();
    const accessToken = tokens?.access_token?.trim() ?? "";
    if (!accessToken) {
      return badPopupResponse("OAuth flow completed without an access token");
    }
    return new NextResponse(
      oauthPopupResultHtml({
        ok: true,
        sourceUrl: sourceUrl.toString(),
        accessToken,
        refreshToken: tokens?.refresh_token,
        scope: tokens?.scope,
        expiresIn: typeof tokens?.expires_in === "number" ? tokens.expires_in : undefined,
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }

  const authorizationUrl = provider.getAuthorizationUrl();
  if (!authorizationUrl) {
    return badPopupResponse("Server did not request an OAuth authorization step");
  }

  const pendingCookie = encodePendingCookieValue(provider.toPending(sourceUrl.toString()));
  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set({
    name: buildPendingCookieName(state),
    value: pendingCookie,
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  return response;
}
