import { discoverOAuthProtectedResourceMetadata, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import { fetchMcpOAuth } from "../../../../lib/mcp/oauth-fetch";
import { parseMcpSourceUrl } from "../../../../lib/mcp/oauth-url";

type DetectResponse = {
  oauth: boolean;
  authorizationServers: Array<string>;
  detail?: string;
};

const MCP_OAUTH_CHALLENGE_PROBE_TIMEOUT_MS = 2_500;
const MCP_OAUTH_METADATA_TIMEOUT_MS = 12_000;

const noStoreDetectJson = (payload: DetectResponse, status = 200): Response =>
  Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });

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

const probeOAuthChallenge = async (sourceUrl: URL): Promise<boolean> => {
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
            name: "Executor v2 OAuth Detector",
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

  const hasBearerChallenge = /^Bearer\s/i.test(
    response.headers.get("WWW-Authenticate") ?? "",
  );
  const challenge = extractWWWAuthenticateParams(response);

  await response.body?.cancel();

  if ((response.status === 401 || response.status === 403) && hasBearerChallenge) {
    return true;
  }

  return Boolean(challenge.resourceMetadataUrl);
};

const toErrorDetail = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const sourceUrlRaw = requestUrl.searchParams.get("sourceUrl")?.trim() ?? "";

  if (!sourceUrlRaw) {
    return noStoreDetectJson(
      {
        oauth: false,
        authorizationServers: [],
        detail: "Missing sourceUrl",
      },
      400,
    );
  }

  let sourceUrl: URL;
  try {
    sourceUrl = parseMcpSourceUrl(sourceUrlRaw);
  } catch (error) {
    return noStoreDetectJson(
      {
        oauth: false,
        authorizationServers: [],
        detail: toErrorDetail(error, "Invalid sourceUrl"),
      },
      400,
    );
  }

  try {
    const oauthByChallenge = await probeOAuthChallenge(sourceUrl);
    if (oauthByChallenge) {
      return noStoreDetectJson({
        oauth: true,
        authorizationServers: [],
        detail: "OAuth detected from endpoint challenge",
      });
    }
  } catch {
    // Continue to metadata discovery.
  }

  let metadata: unknown;
  try {
    metadata = await withTimeout(
      () =>
        discoverOAuthProtectedResourceMetadata(
          sourceUrl,
          undefined,
          (input, init) =>
            fetchMcpOAuth(input, init ?? {}, {
              timeoutMs: MCP_OAUTH_METADATA_TIMEOUT_MS,
              label: "OAuth metadata lookup",
            }),
        ),
      MCP_OAUTH_METADATA_TIMEOUT_MS,
      "OAuth metadata lookup",
    );
  } catch (error) {
    return noStoreDetectJson(
      {
        oauth: false,
        authorizationServers: [],
        detail: toErrorDetail(error, "OAuth metadata lookup failed"),
      },
      502,
    );
  }

  const authorizationServersRaw =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as { authorization_servers?: unknown }).authorization_servers
      : undefined;

  const authorizationServers = Array.isArray(authorizationServersRaw)
    ? authorizationServersRaw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    : [];

  return noStoreDetectJson({
    oauth: authorizationServers.length > 0,
    authorizationServers,
  });
}
