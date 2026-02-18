import { createFileRoute } from "@tanstack/react-router";
import { appendDeleteCookie, readCookie } from "@/lib/http/cookies";
import { noStoreJson } from "@/lib/http/response";
import {
  decodePopupResultCookieValue,
  MCP_OAUTH_RESULT_COOKIE,
  type McpOAuthPopupResult,
} from "@/lib/mcp/oauth-provider";

type PopupMessage =
  | {
      type: "executor:mcp-oauth-result";
      ok: true;
      sourceUrl: string;
      payload: {
        accessToken: string;
        refreshToken?: string;
        scope?: string;
        expiresIn?: number;
      };
    }
  | {
      type: "executor:mcp-oauth-result";
      ok: false;
      error: string;
    };

function toPopupMessage(result: McpOAuthPopupResult | null): PopupMessage {
  if (!result) {
    return {
      type: "executor:mcp-oauth-result",
      ok: false,
      error: "OAuth result is missing or expired",
    };
  }

  if (!result.ok) {
    return {
      type: "executor:mcp-oauth-result",
      ok: false,
      error: result.error ?? "OAuth failed",
    };
  }

  const accessToken = result.accessToken?.trim() ?? "";
  if (!accessToken) {
    return {
      type: "executor:mcp-oauth-result",
      ok: false,
      error: "OAuth finished without an access token",
    };
  }

  return {
    type: "executor:mcp-oauth-result",
    ok: true,
    sourceUrl: result.sourceUrl ?? "",
    payload: {
      accessToken,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      ...(result.scope ? { scope: result.scope } : {}),
      ...(typeof result.expiresIn === "number" ? { expiresIn: result.expiresIn } : {}),
    },
  };
}

async function handleResult(request: Request): Promise<Response> {
  const encoded = readCookie(request, MCP_OAUTH_RESULT_COOKIE) ?? "";
  const parsed = encoded ? decodePopupResultCookieValue(encoded) : null;
  const message = toPopupMessage(parsed);

  const response = noStoreJson(message, message.ok ? 200 : 400);
  appendDeleteCookie(response.headers, MCP_OAUTH_RESULT_COOKIE, {
    path: "/",
  });
  return response;
}

export const Route = createFileRoute("/mcp/oauth/result")({
  server: {
    handlers: {
      GET: ({ request }) => handleResult(request),
    },
  },
});
