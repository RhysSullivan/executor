import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";

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

export async function GET(request: NextRequest) {
  const sourceUrlRaw = request.nextUrl.searchParams.get("sourceUrl")?.trim() ?? "";
  if (!sourceUrlRaw) {
    return noStoreJson({ oauth: false, authorizationServers: [], detail: "Missing sourceUrl" }, 400);
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourceUrlRaw);
  } catch {
    return noStoreJson({ oauth: false, authorizationServers: [], detail: "Invalid sourceUrl" }, 400);
  }

  try {
    const metadata = await discoverOAuthProtectedResourceMetadata(sourceUrl);
    const authorizationServers = Array.isArray((metadata as { authorization_servers?: unknown }).authorization_servers)
      ? (metadata as { authorization_servers: unknown[] }).authorization_servers.filter(
          (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
        )
      : [];

    return noStoreJson({
      oauth: authorizationServers.length > 0,
      authorizationServers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth metadata lookup failed";
    return noStoreJson({
      oauth: false,
      authorizationServers: [],
      detail: message,
    });
  }
}
