import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  decodePopupResultCookieValue,
  MCP_OAUTH_RESULT_COOKIE,
  type McpOAuthPopupResult,
} from "../../../../lib/mcp/oauth-provider";

type PopupMessage =
  | {
      type: "executor-v2:mcp-oauth-result";
      ok: true;
      sourceUrl: string;
      payload: {
        accessToken: string;
        refreshToken?: string;
        scope?: string;
        expiresIn?: number;
        clientId?: string;
        clientInformationJson?: string;
      };
    }
  | {
      type: "executor-v2:mcp-oauth-result";
      ok: false;
      error: string;
    };

const toPopupMessage = (result: McpOAuthPopupResult | null): PopupMessage => {
  if (!result) {
    return {
      type: "executor-v2:mcp-oauth-result",
      ok: false,
      error: "OAuth result is missing or expired",
    };
  }

  if (!result.ok) {
    return {
      type: "executor-v2:mcp-oauth-result",
      ok: false,
      error: result.error ?? "OAuth failed",
    };
  }

  const accessToken = result.accessToken?.trim() ?? "";
  if (accessToken.length === 0) {
    return {
      type: "executor-v2:mcp-oauth-result",
      ok: false,
      error: "OAuth finished without an access token",
    };
  }

  return {
    type: "executor-v2:mcp-oauth-result",
    ok: true,
    sourceUrl: result.sourceUrl ?? "",
    payload: {
      accessToken,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      ...(result.scope ? { scope: result.scope } : {}),
      ...(typeof result.expiresIn === "number"
        ? { expiresIn: result.expiresIn }
        : {}),
      ...(result.clientId ? { clientId: result.clientId } : {}),
      ...(result.clientInformationJson
        ? { clientInformationJson: result.clientInformationJson }
        : {}),
    },
  };
};

export async function GET(request: NextRequest): Promise<Response> {
  const encoded = request.cookies.get(MCP_OAUTH_RESULT_COOKIE)?.value ?? "";
  const parsed = encoded ? decodePopupResultCookieValue(encoded) : null;
  const message = toPopupMessage(parsed);

  const response = NextResponse.json(message, {
    status: message.ok ? 200 : 400,
    headers: {
      "cache-control": "no-store",
    },
  });

  response.cookies.set({
    name: MCP_OAUTH_RESULT_COOKIE,
    value: "",
    expires: new Date(0),
    path: "/",
  });

  return response;
}
