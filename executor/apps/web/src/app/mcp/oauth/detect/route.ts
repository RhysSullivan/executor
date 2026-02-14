import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Result } from "better-result";
import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { parseMcpSourceUrl } from "@/lib/mcp-oauth-url";

type DetectResponse = {
  oauth: boolean;
  authorizationServers: string[];
  detail?: string;
};

function noStoreJson(payload: DetectResponse, status = 200): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
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
    return noStoreJson({ oauth: false, authorizationServers: [], detail: "Missing sourceUrl" }, 400);
  }

  const sourceUrlResult = parseMcpSourceUrl(sourceUrlRaw);
  if (!sourceUrlResult.isOk()) {
    return noStoreJson(
      {
        oauth: false,
        authorizationServers: [],
        detail: resultErrorMessage(sourceUrlResult.error, "Invalid sourceUrl"),
      },
      400,
    );
  }
  const sourceUrl = sourceUrlResult.value;

  const metadataResult = await Result.tryPromise(() => discoverOAuthProtectedResourceMetadata(sourceUrl));
  if (!metadataResult.isOk()) {
    return noStoreJson({
      oauth: false,
      authorizationServers: [],
      detail: resultErrorMessage(metadataResult.error, "OAuth metadata lookup failed"),
    });
  }

  const metadata = metadataResult.value;
  const authorizationServers = Array.isArray((metadata as { authorization_servers?: unknown }).authorization_servers)
    ? (metadata as { authorization_servers: unknown[] }).authorization_servers.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];

  return noStoreJson({
    oauth: authorizationServers.length > 0,
    authorizationServers,
  });
}
