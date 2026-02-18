import { createFileRoute } from "@tanstack/react-router";
import { Result } from "better-result";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { appendDeleteCookie, appendSetCookie, readCookie } from "@/lib/http/cookies";
import { redirectResponse } from "@/lib/http/response";
import { fetchMcpOAuth } from "@/lib/mcp/oauth-fetch";
import { getExternalOrigin, isExternalHttps } from "@/lib/mcp/oauth-request";
import { parseMcpSourceUrl } from "@/lib/mcp/oauth-url";
import {
  buildPendingCookieName,
  decodePendingCookieValue,
  encodePopupResultCookieValue,
  MCP_OAUTH_RESULT_COOKIE,
  McpPopupOAuthProvider,
  type McpOAuthPopupResult,
} from "@/lib/mcp/oauth-provider";

const MCP_OAUTH_CALLBACK_FLOW_TIMEOUT_MS = 75_000;
const MCP_OAUTH_CALLBACK_REQUEST_TIMEOUT_MS = 20_000;

function popupResultRedirect(
  request: Request,
  pendingCookieName: string | null,
  payload: McpOAuthPopupResult,
): Response {
  const origin = getExternalOrigin(request);
  const response = redirectResponse(`${origin}/mcp/oauth/complete`);
  appendSetCookie(response.headers, MCP_OAUTH_RESULT_COOKIE, encodePopupResultCookieValue(payload), {
    httpOnly: true,
    secure: isExternalHttps(request),
    sameSite: "lax",
    maxAge: 2 * 60,
    path: "/",
  });
  if (pendingCookieName) {
    appendDeleteCookie(response.headers, pendingCookieName, {
      path: "/",
    });
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

async function withTimeout<T>(factory: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
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
}

async function handleCallback(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code")?.trim() ?? "";
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  const error = requestUrl.searchParams.get("error")?.trim();

  if (!state) {
    return popupResultRedirect(request, null, { ok: false, error: "Missing OAuth state" });
  }

  const cookieName = buildPendingCookieName(state);
  const rawPending = readCookie(request, cookieName);
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

  const authResult = await Result.tryPromise(() =>
    withTimeout(
      () => auth(provider, {
        serverUrl: sourceUrl,
        authorizationCode: code,
        fetchFn: (input, init) => fetchMcpOAuth(input, init ?? {}, {
          timeoutMs: MCP_OAUTH_CALLBACK_REQUEST_TIMEOUT_MS,
          label: "OAuth callback request",
        }),
      }),
      MCP_OAUTH_CALLBACK_FLOW_TIMEOUT_MS,
      "OAuth callback",
    )
  );
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

export const Route = createFileRoute("/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: ({ request }) => handleCallback(request),
    },
  },
});
