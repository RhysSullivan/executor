import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { resolveAnthropicAuth, type ResolvedAnthropicAuth } from "./anthropic-auth.js";

const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REQUIRED_OAUTH_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.2 (external, cli)";
const TOOL_PREFIX = "mcp_";

let cachedAuthPromise: Promise<ResolvedAnthropicAuth | null> | undefined;
let refreshInFlight: Promise<void> | undefined;

export interface AnthropicModelSelection {
  model: LanguageModel;
  authSource: string;
  authMode: "api" | "oauth";
}

export async function getAnthropicModel(modelID: string): Promise<AnthropicModelSelection> {
  const auth = await getResolvedAuth();
  if (!auth) {
    throw new Error(
      "No Anthropic credentials found. Set OPENASSISTANT_ANTHROPIC_API_KEY or OPENASSISTANT_ANTHROPIC_ACCESS_TOKEN (or configure opencode auth).",
    );
  }

  if (auth.mode === "api") {
    const anthropic = createAnthropic({
      apiKey: auth.apiKey,
    });
    return {
      model: anthropic(modelID),
      authSource: auth.source,
      authMode: "api",
    };
  }

  const oauthFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await ensureFreshToken(auth);

    const headers = mergeHeaders(input, init?.headers);
    headers.set("authorization", `Bearer ${auth.accessToken}`);
    headers.set("anthropic-beta", mergeBetas(headers.get("anthropic-beta")));
    headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
    headers.delete("x-api-key");

    const transformedBody = transformRequestBody(init?.body);
    const withBetaURL = ensureBetaMessagesURL(input);

    const response = await fetch(withBetaURL, {
      ...init,
      headers,
      ...(transformedBody !== undefined ? { body: transformedBody } : {}),
    });

    return transformResponseBody(response);
  }) as typeof fetch;

  const anthropic = createAnthropic({
    apiKey: "opencode-oauth-dummy-key",
    fetch: oauthFetch,
  });

  return {
    model: anthropic(modelID),
    authSource: auth.source,
    authMode: "oauth",
  };
}

async function getResolvedAuth(): Promise<ResolvedAnthropicAuth | null> {
  if (!cachedAuthPromise) {
    cachedAuthPromise = resolveAnthropicAuth();
  }
  return cachedAuthPromise;
}

async function ensureFreshToken(auth: Extract<ResolvedAnthropicAuth, { mode: "oauth" }>): Promise<void> {
  const now = Date.now();
  const expiresAt = auth.expiresAt;
  const mustRefresh = !auth.accessToken || (typeof expiresAt === "number" && now + 30_000 >= expiresAt);
  if (!mustRefresh) {
    return;
  }

  if (!auth.refreshToken) {
    throw new Error("Anthropic OAuth access token expired and no refresh token is available.");
  }

  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken(auth).finally(() => {
      refreshInFlight = undefined;
    });
  }

  await refreshInFlight;
}

async function refreshAccessToken(auth: Extract<ResolvedAnthropicAuth, { mode: "oauth" }>): Promise<void> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: auth.clientId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic OAuth token refresh failed (${response.status}).`);
  }

  const json = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };

  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("Anthropic OAuth token refresh returned no access token.");
  }

  auth.accessToken = json.access_token;
  if (typeof json.refresh_token === "string" && json.refresh_token.length > 0) {
    auth.refreshToken = json.refresh_token;
  }
  if (typeof json.expires_in === "number" && Number.isFinite(json.expires_in)) {
    auth.expiresAt = Date.now() + json.expires_in * 1_000;
  }
}

function mergeBetas(existing: string | null): string {
  const current = (existing ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return [...new Set([...REQUIRED_OAUTH_BETAS, ...current])].join(",");
}

function mergeHeaders(input: RequestInfo | URL, initHeaders: HeadersInit | undefined): Headers {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  if (initHeaders) {
    const candidate = new Headers(initHeaders);
    candidate.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return headers;
}

function transformRequestBody(body: RequestInit["body"]): RequestInit["body"] {
  if (typeof body !== "string") {
    return body;
  }

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const tools = parsed["tools"];
    if (Array.isArray(tools)) {
      parsed["tools"] = tools.map((tool) => {
        if (!tool || typeof tool !== "object") {
          return tool;
        }
        const candidate = tool as Record<string, unknown>;
        const name = candidate["name"];
        if (typeof name === "string" && name.length > 0 && !name.startsWith(TOOL_PREFIX)) {
          return {
            ...candidate,
            name: `${TOOL_PREFIX}${name}`,
          };
        }
        return tool;
      });
    }

    const messages = parsed["messages"];
    if (Array.isArray(messages)) {
      parsed["messages"] = messages.map((message) => {
        if (!message || typeof message !== "object") {
          return message;
        }
        const candidate = message as Record<string, unknown>;
        const content = candidate["content"];
        if (!Array.isArray(content)) {
          return message;
        }
        return {
          ...candidate,
          content: content.map((block) => {
            if (!block || typeof block !== "object") {
              return block;
            }
            const value = block as Record<string, unknown>;
            if (value["type"] !== "tool_use") {
              return block;
            }
            const name = value["name"];
            if (typeof name !== "string" || name.length === 0 || name.startsWith(TOOL_PREFIX)) {
              return block;
            }
            return {
              ...value,
              name: `${TOOL_PREFIX}${name}`,
            };
          }),
        };
      });
    }

    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function ensureBetaMessagesURL(input: RequestInfo | URL): RequestInfo | URL {
  let inputIsRequest = false;
  let parsed: URL | null = null;
  try {
    if (input instanceof Request) {
      inputIsRequest = true;
      parsed = new URL(input.url);
    } else if (input instanceof URL) {
      parsed = new URL(input.toString());
    } else if (typeof input === "string") {
      parsed = new URL(input);
    }
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.pathname !== "/v1/messages" || parsed.searchParams.has("beta")) {
    return input;
  }

  parsed.searchParams.set("beta", "true");
  if (inputIsRequest && input instanceof Request) {
    return new Request(parsed.toString(), input);
  }
  return parsed;
}

async function transformResponseBody(response: Response): Promise<Response> {
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      const text = decoder
        .decode(value, { stream: true })
        .replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
      controller.enqueue(encoder.encode(text));
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
