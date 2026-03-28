import { createHash, randomBytes } from "node:crypto";

import * as Effect from "effect/Effect";

export type OAuth2TokenResponse = {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

export type OAuth2ClientAuthenticationMethod =
  | "none"
  | "client_secret_post";

const encodeBase64Url = (input: Buffer): string =>
  input.toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const createPkceCodeVerifier = (): string =>
  encodeBase64Url(randomBytes(48));

export const createPkceCodeChallenge = (verifier: string): string =>
  encodeBase64Url(createHash("sha256").update(verifier).digest());

export const buildOAuth2AuthorizationUrl = (input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: ReadonlyArray<string>;
  state: string;
  codeVerifier: string;
  extraParams?: Readonly<Record<string, string>>;
}): string => {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set(
    "code_challenge",
    createPkceCodeChallenge(input.codeVerifier),
  );

  for (const [key, value] of Object.entries(input.extraParams ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
};

const parseOAuth2TokenResponse = async (
  response: Response,
): Promise<OAuth2TokenResponse> => {
  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(
      `OAuth token endpoint returned non-JSON response (${response.status})`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `OAuth token endpoint returned invalid JSON payload (${response.status})`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const accessToken =
    typeof record.access_token === "string" && record.access_token.length > 0
      ? record.access_token
      : null;

  if (!response.ok) {
    const description =
      typeof record.error_description === "string"
      && record.error_description.length > 0
        ? record.error_description
        : typeof record.error === "string" && record.error.length > 0
          ? record.error
          : `status ${response.status}`;
    throw new Error(`OAuth token exchange failed: ${description}`);
  }

  if (accessToken === null) {
    throw new Error("OAuth token endpoint did not return an access_token");
  }

  return {
    access_token: accessToken,
    token_type:
      typeof record.token_type === "string" ? record.token_type : undefined,
    refresh_token:
      typeof record.refresh_token === "string"
        ? record.refresh_token
        : undefined,
    expires_in: typeof record.expires_in === "number"
      ? record.expires_in
      : typeof record.expires_in === "string"
        ? Number(record.expires_in)
        : undefined,
    scope: typeof record.scope === "string" ? record.scope : undefined,
  };
};

const postFormToOAuth2TokenEndpoint = (input: {
  tokenEndpoint: string;
  body: URLSearchParams;
}): Effect.Effect<OAuth2TokenResponse, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(input.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: input.body,
        signal: AbortSignal.timeout(20_000),
      });

      return parseOAuth2TokenResponse(response);
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

export const exchangeOAuth2AuthorizationCode = (input: {
  tokenEndpoint: string;
  clientId: string;
  clientAuthentication: OAuth2ClientAuthenticationMethod;
  clientSecret?: string | null;
  redirectUri: string;
  codeVerifier: string;
  code: string;
}): Effect.Effect<OAuth2TokenResponse, Error, never> =>
  Effect.gen(function* () {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      code: input.code,
    });

    if (
      input.clientAuthentication === "client_secret_post"
      && input.clientSecret
    ) {
      body.set("client_secret", input.clientSecret);
    }

    return yield* postFormToOAuth2TokenEndpoint({
      tokenEndpoint: input.tokenEndpoint,
      body,
    });
  });

export const refreshOAuth2AccessToken = (input: {
  tokenEndpoint: string;
  clientId: string;
  clientAuthentication: OAuth2ClientAuthenticationMethod;
  clientSecret?: string | null;
  refreshToken: string;
  scopes?: ReadonlyArray<string> | null;
}): Effect.Effect<OAuth2TokenResponse, Error, never> =>
  Effect.gen(function* () {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
    });

    if (
      input.clientAuthentication === "client_secret_post"
      && input.clientSecret
    ) {
      body.set("client_secret", input.clientSecret);
    }

    if (input.scopes && input.scopes.length > 0) {
      body.set("scope", input.scopes.join(" "));
    }

    return yield* postFormToOAuth2TokenEndpoint({
      tokenEndpoint: input.tokenEndpoint,
      body,
    });
  });
