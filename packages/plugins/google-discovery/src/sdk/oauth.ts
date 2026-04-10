import { createHash, randomBytes } from "node:crypto";

import { Effect } from "effect";

import { GoogleDiscoveryOAuthError } from "./errors";

export type OAuth2TokenResponse = {
  readonly access_token: string;
  readonly token_type?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
};

const encodeBase64Url = (input: Buffer): string =>
  input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const createPkceCodeVerifier = (): string => encodeBase64Url(randomBytes(48));

const createPkceCodeChallenge = (verifier: string): string =>
  encodeBase64Url(createHash("sha256").update(verifier).digest());

export const buildGoogleAuthorizationUrl = (input: {
  readonly clientId: string;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly codeVerifier: string;
}): string => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", createPkceCodeChallenge(input.codeVerifier));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  return url.toString();
};

const decodeTokenResponse = async (response: Response): Promise<OAuth2TokenResponse> => {
  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`OAuth token endpoint returned non-JSON response (${response.status})`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OAuth token endpoint returned invalid JSON payload (${response.status})`);
  }

  const record = parsed as Record<string, unknown>;
  const accessToken =
    typeof record.access_token === "string" && record.access_token.length > 0
      ? record.access_token
      : null;

  if (!response.ok) {
    const description =
      typeof record.error_description === "string"
        ? record.error_description
        : typeof record.error === "string"
          ? record.error
          : `status ${response.status}`;
    throw new Error(`OAuth token exchange failed: ${description}`);
  }

  if (accessToken === null) {
    throw new Error("OAuth token endpoint did not return an access_token");
  }

  return {
    access_token: accessToken,
    token_type: typeof record.token_type === "string" ? record.token_type : undefined,
    refresh_token: typeof record.refresh_token === "string" ? record.refresh_token : undefined,
    expires_in:
      typeof record.expires_in === "number"
        ? record.expires_in
        : typeof record.expires_in === "string"
          ? Number(record.expires_in)
          : undefined,
    scope: typeof record.scope === "string" ? record.scope : undefined,
  };
};

const postToTokenEndpoint = (body: URLSearchParams) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      return decodeTokenResponse(response);
    },
    catch: (cause) =>
      new GoogleDiscoveryOAuthError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export const exchangeAuthorizationCode = (input: {
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly redirectUrl: string;
  readonly codeVerifier: string;
  readonly code: string;
}): Effect.Effect<OAuth2TokenResponse, GoogleDiscoveryOAuthError> =>
  Effect.gen(function* () {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      redirect_uri: input.redirectUrl,
      code_verifier: input.codeVerifier,
      code: input.code,
    });
    if (input.clientSecret) {
      body.set("client_secret", input.clientSecret);
    }
    return yield* postToTokenEndpoint(body);
  });

export const refreshAccessToken = (input: {
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly refreshToken: string;
  readonly scopes?: readonly string[];
}): Effect.Effect<OAuth2TokenResponse, GoogleDiscoveryOAuthError> =>
  Effect.gen(function* () {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
    });
    if (input.clientSecret) {
      body.set("client_secret", input.clientSecret);
    }
    if (input.scopes && input.scopes.length > 0) {
      body.set("scope", input.scopes.join(" "));
    }
    return yield* postToTokenEndpoint(body);
  });
