import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Result } from "better-result";
import {
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { fetchMcpOAuth } from "@/lib/mcp/oauth-fetch";
import { parseMcpSourceUrl } from "@/lib/mcp/oauth-url";

type DetectResponse = {
  oauth: boolean;
  authorizationServers: string[];
  detail?: string;
};

const MCP_OAUTH_CHALLENGE_PROBE_TIMEOUT_MS = 2_500;
const MCP_OAUTH_METADATA_TIMEOUT_MS = 12_000;

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

async function probeOAuthChallenge(sourceUrl: URL): Promise<boolean> {
  const response = await fetchMcpOAuth(
    sourceUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "oauth-detect",
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "Executor OAuth Detector",
            version: "1.0.0",
          },
        },
      }),
    },
    {
      timeoutMs: MCP_OAUTH_CHALLENGE_PROBE_TIMEOUT_MS,
      label: "OAuth challenge probe",
    },
  );

  const challengeHeader = response.headers.get("WWW-Authenticate") ?? "";
  const hasBearerChallenge = /^Bearer\s/i.test(challengeHeader);
  await response.body?.cancel();

  if ((response.status === 401 || response.status === 403) && hasBearerChallenge) {
    return true;
  }

  let challenge: ReturnType<typeof extractWWWAuthenticateParams>;
  try {
    challenge = extractWWWAuthenticateParams(response);
  } catch {
    return false;
  }

  return Boolean(challenge.resourceMetadataUrl);
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

  const challengeProbeResult = await Result.tryPromise(() => probeOAuthChallenge(sourceUrl));
  if (challengeProbeResult.isOk() && challengeProbeResult.value) {
    return noStoreJson({
      oauth: true,
      authorizationServers: [],
      detail: "OAuth detected from endpoint challenge",
    });
  }

  const metadataResult = await Result.tryPromise(() =>
    withTimeout(
      () => discoverOAuthProtectedResourceMetadata(
        sourceUrl,
        undefined,
        (input, init) => fetchMcpOAuth(input, init ?? {}, {
          timeoutMs: MCP_OAUTH_METADATA_TIMEOUT_MS,
          label: "OAuth metadata lookup",
        }),
      ),
      MCP_OAUTH_METADATA_TIMEOUT_MS,
      "OAuth metadata lookup",
    )
  );
  if (!metadataResult.isOk()) {
    const probeDetail = challengeProbeResult.isOk()
      ? ""
      : `; challenge probe: ${resultErrorMessage(challengeProbeResult.error, "failed")}`;

    return noStoreJson({
      oauth: false,
      authorizationServers: [],
      detail: `${resultErrorMessage(metadataResult.error, "OAuth metadata lookup failed")}${probeDetail}`,
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
