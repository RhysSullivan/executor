import { handleCallbackRoute } from "@workos/authkit-tanstack-react-start";

import { redirectResponse } from "@/lib/http/response";
import { isWorkosDebugEnabled, logWorkosAuth, redactAuthCode } from "@/lib/workos-debug";
import { resolveWorkosRedirectUri } from "@/lib/workos-redirect";

const callbackHandler = handleCallbackRoute({
  returnPathname: "/",
  onSuccess: ({ user }) => {
    logWorkosAuth("callback.auth-success", {
      userId: user?.id,
      email: user?.email,
    });
  },
});

const WORKOS_CALLBACK_REPLAY_MS = 10 * 60 * 1000;
const CALLBACK_REPLAY_PRUNE_INTERVAL_MS = 30 * 1000;
const callbackCodeReplay = new Map<string, number>();
let nextReplayPruneAt = 0;

type WorkOSCallbackInput = Parameters<typeof callbackHandler>[0];

function pruneCallbackReplays(now = Date.now()): void {
  if (now < nextReplayPruneAt) {
    return;
  }

  callbackCodeReplay.forEach((expiresAt, code) => {
    if (expiresAt <= now) {
      callbackCodeReplay.delete(code);
    }
  });

  nextReplayPruneAt = now + CALLBACK_REPLAY_PRUNE_INTERVAL_MS;
}

function isReplayedCode(code: string, now = Date.now()): boolean {
  pruneCallbackReplays(now);
  const expiresAt = callbackCodeReplay.get(code);

  if (!expiresAt || expiresAt <= now) {
    if (expiresAt) {
      callbackCodeReplay.delete(code);
    }

    return false;
  }

  return true;
}

function markCodeAsReplayed(code: string, now = Date.now()): void {
  callbackCodeReplay.set(code, now + WORKOS_CALLBACK_REPLAY_MS);
}

function getSetCookieValues(responseHeaders: Headers): string[] {
  const getSetCookie = (responseHeaders as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    try {
      return getSetCookie.call(responseHeaders);
    } catch {
      // Fall back to reading the standard header.
    }
  }

  const singleHeader = responseHeaders.get("set-cookie");
  return singleHeader ? [singleHeader] : [];
}

function isInvalidGrantError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  const value = error as { error?: string; errorDescription?: string; rawData?: { error?: string; error_description?: string } };

  if ((value.error?.toLowerCase() === "invalid_grant") || message.toLowerCase().includes("invalid grant")) {
    return true;
  }

  if (value.errorDescription?.toLowerCase().includes("expired")) {
    return true;
  }

  if (value.rawData?.error === "invalid_grant" || value.rawData?.error_description?.toLowerCase().includes("expired") === true) {
    return true;
  }

  return message.toLowerCase().includes("invalid_grant")
    || message.toLowerCase().includes("expired or invalid")
    || message.includes("Error Description:");
}

export async function handleWorkOSCallback(context: WorkOSCallbackInput): Promise<Response> {
  const request = (context as { request: Request }).request;
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code")?.trim() ?? "";
  const requestId = request.headers.get("x-request-id");
  const oauthError = requestUrl.searchParams.get("error")?.trim();
  const oauthErrorDescription = requestUrl.searchParams.get("error_description")?.trim();
  const configuredWorkosRedirectUri = resolveWorkosRedirectUri(request);

  if (isWorkosDebugEnabled()) {
    logWorkosAuth("callback.request", {
      requestId,
      code: redactAuthCode(code),
      path: requestUrl.pathname,
      host: requestUrl.host,
      forwardedHost: request.headers.get("x-forwarded-host"),
      forwardedProto: request.headers.get("x-forwarded-proto"),
      state: requestUrl.searchParams.get("state") ? "present" : "missing",
      authorizationSessionId: requestUrl.searchParams.get("authorization_session_id")
        ? "present"
        : "missing",
      error: oauthError,
      errorDescription: oauthErrorDescription ? "present" : "missing",
      cookieCount: request.headers.get("cookie")?.split(";").length ?? 0,
      configuredWorkosRedirectUri,
    });
  }

  if (code && isReplayedCode(code)) {
    if (isWorkosDebugEnabled()) {
      logWorkosAuth("callback.replay-blocked", {
        requestId,
        code: redactAuthCode(code),
      });
    }

    return redirectResponse("/", 302);
  }

  try {
    const response = await callbackHandler(context);

    const responseHeaders = response.headers;
    const responseHeaderNames = Array.from(responseHeaders.keys());
    const setCookieHeaders = getSetCookieValues(responseHeaders);

    if (isWorkosDebugEnabled()) {
      logWorkosAuth("callback.result", {
        requestId,
        code: redactAuthCode(code),
        status: response.status,
        statusText: response.statusText,
        location: responseHeaders.get("location"),
        headerNames: responseHeaderNames,
        setCookieCount: setCookieHeaders.length,
        setCookieLength: setCookieHeaders[0]?.length ?? 0,
      });
    }

    if (isWorkosDebugEnabled() && setCookieHeaders.length > 0) {
      logWorkosAuth("callback.set-cookie", {
        requestId,
        cookie: setCookieHeaders[0],
      });
    }

    if (isWorkosDebugEnabled() && code && response.status >= 300 && response.status < 400 && setCookieHeaders.length === 0) {
      logWorkosAuth("callback.missing-set-cookie", {
        requestId,
        code: redactAuthCode(code),
        status: response.status,
        statusText: response.statusText,
        location: responseHeaders.get("location"),
        hasLocation: responseHeaders.has("location"),
      });
    }

    if (code && response.status >= 300 && response.status < 400) {
      if (setCookieHeaders.length > 0) {
        markCodeAsReplayed(code);

        if (isWorkosDebugEnabled()) {
          logWorkosAuth("callback.code-marked-used", {
            requestId,
            code: redactAuthCode(code),
            status: response.status,
            setCookieCount: setCookieHeaders.length,
          });
        }
      }
      else if (isWorkosDebugEnabled()) {
        logWorkosAuth("callback.code-not-marked-used", {
          requestId,
          code: redactAuthCode(code),
          status: response.status,
          reason: "missing-set-cookie",
        });
      }

      if (setCookieHeaders.length === 0) {
        return new Response(JSON.stringify({
          error: {
            message: "Authentication did not set a session cookie",
            description: "Sign-in completed but the callback response did not include Set-Cookie.",
          },
        }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }

      return response;
    }

    if (isWorkosDebugEnabled()) {
      logWorkosAuth("callback.complete", {
        requestId,
        code: redactAuthCode(code),
        status: response.status,
        statusText: response.statusText,
      });
    }

    return response;
  }
  catch (callbackError) {
    const callbackErrorMessage = callbackError instanceof Error ? callbackError.message : String(callbackError);
    const invalidGrant = isInvalidGrantError(callbackError);

    if (isWorkosDebugEnabled()) {
      logWorkosAuth("callback.failure", {
        requestId,
        code: redactAuthCode(code),
        error: callbackErrorMessage,
        errorKind: invalidGrant ? "invalid_grant" : "callback_error",
        oauthError,
        oauthErrorDescription,
      });
    }

    if (code && invalidGrant) {
      markCodeAsReplayed(code);

      return redirectResponse("/", 302);
    }

    return new Response(JSON.stringify({
      error: {
        message: "Authentication failed",
        description: "Couldn't sign in. Please contact your organization admin if the issue persists.",
        details: callbackErrorMessage,
      },
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
