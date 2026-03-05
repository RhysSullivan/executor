import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { fetchMcpOAuth } from "../../../../lib/mcp/oauth-fetch";
import { getExternalOrigin, isExternalHttps } from "../../../../lib/mcp/oauth-request";
import { parseMcpSourceUrl } from "../../../../lib/mcp/oauth-url";
import {
  buildPendingCookieName,
  decodePendingCookieValue,
  encodePopupResultCookieValue,
  MCP_OAUTH_RESULT_COOKIE,
  McpPopupOAuthProvider,
  type McpOAuthPopupResult,
} from "../../../../lib/mcp/oauth-provider";

const MCP_OAUTH_CALLBACK_FLOW_TIMEOUT_MS = 75_000;
const MCP_OAUTH_CALLBACK_REQUEST_TIMEOUT_MS = 20_000;

const withTimeout = async <T>(
  factory: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    factory().then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });

const popupResultRedirect = (
  request: NextRequest,
  pendingCookieName: string | null,
  payload: McpOAuthPopupResult,
): Response => {
  const origin = getExternalOrigin(request);
  const response = NextResponse.redirect(new URL("/mcp/oauth/complete", origin));

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
    response.cookies.set({
      name: pendingCookieName,
      value: "",
      expires: new Date(0),
      path: "/",
    });
  }

  return response;
};

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export async function GET(request: NextRequest): Promise<Response> {
  const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  const state = request.nextUrl.searchParams.get("state")?.trim() ?? "";
  const oauthError = request.nextUrl.searchParams.get("error")?.trim() ?? "";

  if (!state) {
    return popupResultRedirect(request, null, {
      ok: false,
      error: "Missing OAuth state",
    });
  }

  const pendingCookieName = buildPendingCookieName(state);
  const rawPending = request.cookies.get(pendingCookieName)?.value ?? "";
  const pending = rawPending ? decodePendingCookieValue(rawPending) : null;

  if (!pending) {
    return popupResultRedirect(request, pendingCookieName, {
      ok: false,
      error: "OAuth session expired. Try connecting again.",
    });
  }

  if (oauthError.length > 0) {
    return popupResultRedirect(request, pendingCookieName, {
      ok: false,
      error: `OAuth error: ${oauthError}`,
    });
  }

  if (code.length === 0) {
    return popupResultRedirect(request, pendingCookieName, {
      ok: false,
      error: "Missing OAuth authorization code",
    });
  }

  let sourceUrl: URL;
  try {
    sourceUrl = parseMcpSourceUrl(pending.sourceUrl);
  } catch {
    return popupResultRedirect(request, pendingCookieName, {
      ok: false,
      error: "Invalid MCP source URL",
    });
  }

  const provider = new McpPopupOAuthProvider({
    redirectUrl: pending.redirectUrl,
    state: pending.state,
    codeVerifier: pending.codeVerifier,
    clientInformation: pending.clientInformation,
  });

  try {
    await withTimeout(
      () =>
        auth(provider, {
          serverUrl: sourceUrl,
          authorizationCode: code,
          fetchFn: (input, init) =>
            fetchMcpOAuth(input, init ?? {}, {
              timeoutMs: MCP_OAUTH_CALLBACK_REQUEST_TIMEOUT_MS,
              label: "OAuth callback request",
            }),
        }),
      MCP_OAUTH_CALLBACK_FLOW_TIMEOUT_MS,
      "OAuth callback",
    );
  } catch (error) {
    return popupResultRedirect(request, pendingCookieName, {
      ok: false,
      error: toErrorMessage(error, "Failed to finish OAuth"),
    });
  }

  const tokens = provider.getTokens();
  const clientInformation = provider.clientInformation() ?? pending.clientInformation;
  const clientId =
    clientInformation && typeof clientInformation.client_id === "string"
      ? clientInformation.client_id.trim() || undefined
      : undefined;
  const clientInformationJson = clientInformation
    ? JSON.stringify(clientInformation)
    : undefined;
  const accessToken = tokens?.access_token?.trim() ?? "";

  if (accessToken.length === 0) {
    return popupResultRedirect(request, pendingCookieName, {
      ok: false,
      error: "OAuth completed without an access token",
    });
  }

  return popupResultRedirect(request, pendingCookieName, {
    ok: true,
    sourceUrl: pending.sourceUrl,
    accessToken,
    refreshToken: tokens?.refresh_token,
    scope: tokens?.scope,
    expiresIn: typeof tokens?.expires_in === "number" ? tokens.expires_in : undefined,
    clientId,
    clientInformationJson,
  });
}
