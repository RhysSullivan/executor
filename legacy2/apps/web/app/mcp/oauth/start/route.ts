import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { fetchMcpOAuth } from "../../../../lib/mcp/oauth-fetch";
import { getExternalOrigin, isExternalHttps } from "../../../../lib/mcp/oauth-request";
import { parseMcpSourceUrl } from "../../../../lib/mcp/oauth-url";
import {
  buildPendingCookieName,
  createOAuthState,
  encodePendingCookieValue,
  encodePopupResultCookieValue,
  MCP_OAUTH_RESULT_COOKIE,
  McpPopupOAuthProvider,
  type McpOAuthPopupResult,
} from "../../../../lib/mcp/oauth-provider";

const MCP_OAUTH_FLOW_TIMEOUT_MS = 75_000;
const MCP_OAUTH_REQUEST_TIMEOUT_MS = 20_000;

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

  return response;
};

const badPopupResponse = (request: NextRequest, message: string): Response =>
  popupResultRedirect(request, { ok: false, error: message });

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export async function GET(request: NextRequest): Promise<Response> {
  const sourceUrlRaw = request.nextUrl.searchParams.get("sourceUrl")?.trim() ?? "";
  if (sourceUrlRaw.length === 0) {
    return badPopupResponse(request, "Missing sourceUrl");
  }

  let sourceUrl: URL;
  try {
    sourceUrl = parseMcpSourceUrl(sourceUrlRaw);
  } catch (error) {
    return badPopupResponse(request, toErrorMessage(error, "Invalid sourceUrl"));
  }

  const state = createOAuthState();
  const redirectUrl = `${getExternalOrigin(request)}/mcp/oauth/callback`;
  const provider = new McpPopupOAuthProvider({
    redirectUrl,
    state,
  });

  let authResult: "AUTHORIZED" | "REDIRECT";
  try {
    authResult = await withTimeout(
      () =>
        auth(provider, {
          serverUrl: sourceUrl,
          fetchFn: (input, init) =>
            fetchMcpOAuth(input, init ?? {}, {
              timeoutMs: MCP_OAUTH_REQUEST_TIMEOUT_MS,
              label: "OAuth startup request",
            }),
        }),
      MCP_OAUTH_FLOW_TIMEOUT_MS,
      "OAuth startup",
    );
  } catch (error) {
    return badPopupResponse(
      request,
      toErrorMessage(error, "Failed to start OAuth flow"),
    );
  }

  if (authResult === "AUTHORIZED") {
    const tokens = provider.getTokens();
    const clientInformation = provider.clientInformation();
    const clientId =
      clientInformation && typeof clientInformation.client_id === "string"
        ? clientInformation.client_id.trim() || undefined
        : undefined;
    const clientInformationJson = clientInformation
      ? JSON.stringify(clientInformation)
      : undefined;
    const accessToken = tokens?.access_token?.trim() ?? "";
    if (accessToken.length === 0) {
      return badPopupResponse(
        request,
        "OAuth flow completed without an access token",
      );
    }

    return popupResultRedirect(request, {
      ok: true,
      sourceUrl: sourceUrl.toString(),
      accessToken,
      refreshToken: tokens?.refresh_token,
      scope: tokens?.scope,
      expiresIn:
        typeof tokens?.expires_in === "number" ? tokens.expires_in : undefined,
      clientId,
      clientInformationJson,
    });
  }

  const authorizationUrl = provider.getAuthorizationUrl();
  if (!authorizationUrl) {
    return badPopupResponse(
      request,
      "Server did not request an OAuth authorization step",
    );
  }

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set({
    name: buildPendingCookieName(state),
    value: encodePendingCookieValue(provider.toPending(sourceUrl.toString())),
    httpOnly: true,
    secure: isExternalHttps(request),
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });

  return response;
}
