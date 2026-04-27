// ---------------------------------------------------------------------------
// OAuth 2.0 helpers — generic, isomorphic building blocks.
//
// Thin wrappers around `oauth4webapi` (stateless; pure Web Crypto +
// `fetch`, no deps; runs unchanged in Node, CF Workers, and browsers).
// Each public helper is a single `Effect.tryPromise` call that delegates
// the RFC work to the library and normalises the failure surface into
// `OAuth2Error`.
//
// What stays hand-rolled:
//   - `OAuth2Error` — our tagged error; we want a stable shape across
//     every token-endpoint call
//   - `shouldRefreshToken` — skew check, trivial
//   - `buildAuthorizationUrl` — the library doesn't expose a raw
//     authorization-URL builder (it prefers PAR); a 30-line manual
//     construction keeps the call sync and lets callers opt out of PAR
// ---------------------------------------------------------------------------

import { Data, Effect } from "effect";
import * as oauth from "oauth4webapi";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OAuth2Error extends Data.TaggedError("OAuth2Error")<{
  readonly message: string;
  /**
   * RFC 6749 §5.2 error code, when the token endpoint returned one
   * (`invalid_grant`, `invalid_client`, `unauthorized_client`, ...).
   * Callers use this to distinguish terminal failures (a refresh token
   * the AS no longer honours → re-auth required) from transient ones.
   */
  readonly error?: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Token response shape (RFC 6749 §5.1)
// ---------------------------------------------------------------------------

export type OAuth2TokenResponse = {
  readonly access_token: string;
  readonly token_type?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Refresh tokens this many ms before expiry to avoid mid-request expiration. */
export const OAUTH2_REFRESH_SKEW_MS = 60_000;

/** Default token-endpoint timeout. */
export const OAUTH2_DEFAULT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — straight delegation to `oauth4webapi`
// ---------------------------------------------------------------------------

export const createPkceCodeVerifier = (): string =>
  oauth.generateRandomCodeVerifier();

export const createPkceCodeChallenge = (verifier: string): Promise<string> =>
  oauth.calculatePKCECodeChallenge(verifier);

// ---------------------------------------------------------------------------
// Authorization URL builder
// ---------------------------------------------------------------------------

export type BuildAuthorizationUrlInput = {
  readonly authorizationUrl: string;
  readonly clientId: string;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
  readonly state: string;
  /** Pre-computed base64url S256 challenge (from `createPkceCodeChallenge`). */
  readonly codeChallenge: string;
  /** Separator between scopes. RFC 6749 says space; some providers use comma. */
  readonly scopeSeparator?: string;
  /** Provider-specific extras (e.g. Google's `access_type=offline`). */
  readonly extraParams?: Readonly<Record<string, string>>;
};

/** Build an RFC 6749 §4.1.1 authorization URL. Sync; pre-computed
 *  challenge lets this stay out of the Promise world. */
export const buildAuthorizationUrl = (input: BuildAuthorizationUrlInput): string => {
  const url = new URL(input.authorizationUrl);
  const separator = input.scopeSeparator ?? " ";
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(separator));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", input.codeChallenge);
  if (input.extraParams) {
    for (const [k, v] of Object.entries(input.extraParams)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
};

// ---------------------------------------------------------------------------
// Error mapping — `oauth4webapi`'s `process*Response` failure shapes are
// either a WWW-Authenticate challenge or an RFC 6749 §5.2 error body,
// both exposed via `.error` / `.error_description`. Probing the envelope
// preserves RFC 6749 error-code semantics (e.g., mapping `invalid_grant`
// to reauth-required) across wrappers.
// ---------------------------------------------------------------------------

const toOAuth2Error = (cause: unknown): OAuth2Error => {
  if (typeof cause === "object" && cause !== null) {
    const c = cause as {
      error?: unknown;
      error_description?: unknown;
      message?: unknown;
    };
    const code = typeof c.error === "string" ? c.error : undefined;
    const description =
      typeof c.error_description === "string"
        ? c.error_description
        : typeof c.message === "string"
          ? c.message
          : undefined;
    return new OAuth2Error({
      message: `OAuth token exchange failed: ${description ?? code ?? "unknown error"}`,
      error: code,
      cause,
    });
  }
  return new OAuth2Error({
    message: `OAuth token exchange failed: ${String(cause)}`,
    cause,
  });
};

// ---------------------------------------------------------------------------
// oauth4webapi adapter helpers
// ---------------------------------------------------------------------------

export type ClientAuthMethod = "body" | "basic";

const asFromTokenUrl = (tokenUrl: string): oauth.AuthorizationServer => {
  const url = new URL(tokenUrl);
  return {
    issuer: `${url.protocol}//${url.host}`,
    token_endpoint: tokenUrl,
  };
};

const asFromTokenUrlAndIssuer = (
  tokenUrl: string,
  issuerUrl: string | null | undefined,
): oauth.AuthorizationServer => {
  const as = asFromTokenUrl(tokenUrl);
  return issuerUrl ? { ...as, issuer: issuerUrl } : as;
};

const isLoopbackHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.startsWith("127.")
    );
  } catch {
    return false;
  }
};

const oauth4webapiRequestOptions = (
  targetUrl: string,
  timeoutMs: number | undefined,
): Record<string, unknown> => {
  const options: Record<string, unknown> = {
    signal: AbortSignal.timeout(timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS),
  };
  if (isLoopbackHttpUrl(targetUrl)) {
    (options as { [oauth.allowInsecureRequests]?: boolean })[
      oauth.allowInsecureRequests
    ] = true;
  }
  return options;
};

const pickClientAuth = (
  clientSecret: string | null | undefined,
  method: ClientAuthMethod,
): oauth.ClientAuth => {
  if (!clientSecret) return oauth.None();
  return method === "basic"
    ? oauth.ClientSecretBasic(clientSecret)
    : oauth.ClientSecretPost(clientSecret);
};

const tokenResponseFrom = (
  r: oauth.TokenEndpointResponse,
): OAuth2TokenResponse => ({
  access_token: r.access_token,
  token_type: r.token_type,
  refresh_token: r.refresh_token,
  expires_in: typeof r.expires_in === "number" ? r.expires_in : undefined,
  scope: r.scope,
});

// ---------------------------------------------------------------------------
// Exchange authorization code → tokens
// ---------------------------------------------------------------------------

export type ExchangeAuthorizationCodeInput = {
  readonly tokenUrl: string;
  readonly issuerUrl?: string | null;
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly redirectUrl: string;
  readonly codeVerifier: string;
  readonly code: string;
  readonly clientAuth?: ClientAuthMethod;
  readonly timeoutMs?: number;
};

export const exchangeAuthorizationCode = (
  input: ExchangeAuthorizationCodeInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrlAndIssuer(input.tokenUrl, input.issuerUrl);
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(
        input.clientSecret,
        input.clientAuth ?? "body",
      );
      // `authorizationCodeGrantRequest` requires its `callbackParameters`
      // to have been returned from `validateAuthResponse`. Our public API
      // takes the `code` directly (the UI already validated `state` by
      // looking up the session), so skip the library's state-validation
      // rail and go through the generic grant request instead.
      const params = new URLSearchParams({
        code: input.code,
        redirect_uri: input.redirectUrl,
        code_verifier: input.codeVerifier,
      });
      const response = await oauth.genericTokenEndpointRequest(
        as,
        client,
        clientAuth,
        "authorization_code",
        params,
        oauth4webapiRequestOptions(input.tokenUrl, input.timeoutMs),
      );
      const result = await oauth.processGenericTokenEndpointResponse(
        as,
        client,
        response,
      );
      return tokenResponseFrom(result);
    },
    catch: toOAuth2Error,
  });

// ---------------------------------------------------------------------------
// Exchange client credentials → tokens (RFC 6749 §4.4)
// ---------------------------------------------------------------------------

export type ExchangeClientCredentialsInput = {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes?: readonly string[];
  readonly scopeSeparator?: string;
  readonly clientAuth?: ClientAuthMethod;
  readonly timeoutMs?: number;
};

export const exchangeClientCredentials = (
  input: ExchangeClientCredentialsInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrl(input.tokenUrl);
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(
        input.clientSecret,
        input.clientAuth ?? "body",
      );
      const params = new URLSearchParams();
      if (input.scopes && input.scopes.length > 0) {
        params.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
      }
      const response = await oauth.clientCredentialsGrantRequest(
        as,
        client,
        clientAuth,
        params,
        oauth4webapiRequestOptions(input.tokenUrl, input.timeoutMs),
      );
      const result = await oauth.processClientCredentialsResponse(
        as,
        client,
        response,
      );
      return tokenResponseFrom(result);
    },
    catch: toOAuth2Error,
  });

// ---------------------------------------------------------------------------
// Refresh access token
// ---------------------------------------------------------------------------

export type RefreshAccessTokenInput = {
  readonly tokenUrl: string;
  readonly issuerUrl?: string | null;
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly refreshToken: string;
  readonly scopes?: readonly string[];
  readonly scopeSeparator?: string;
  readonly clientAuth?: ClientAuthMethod;
  readonly timeoutMs?: number;
};

export const refreshAccessToken = (
  input: RefreshAccessTokenInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: async () => {
      const as = asFromTokenUrlAndIssuer(input.tokenUrl, input.issuerUrl);
      const client: oauth.Client = { client_id: input.clientId };
      const clientAuth = pickClientAuth(
        input.clientSecret,
        input.clientAuth ?? "body",
      );
      const additionalParameters =
        input.scopes && input.scopes.length > 0
          ? new URLSearchParams({
              scope: input.scopes.join(input.scopeSeparator ?? " "),
            })
          : undefined;
      const response = await oauth.refreshTokenGrantRequest(
        as,
        client,
        clientAuth,
        input.refreshToken,
        {
          ...oauth4webapiRequestOptions(input.tokenUrl, input.timeoutMs),
          additionalParameters,
        },
      );
      const result = await oauth.processRefreshTokenResponse(
        as,
        client,
        response,
      );
      return tokenResponseFrom(result);
    },
    catch: toOAuth2Error,
  });

// ---------------------------------------------------------------------------
// Refresh-needed predicate
// ---------------------------------------------------------------------------

export const shouldRefreshToken = (input: {
  readonly expiresAt: number | null;
  readonly now?: number;
  readonly skewMs?: number;
}): boolean => {
  if (input.expiresAt === null) return false;
  const now = input.now ?? Date.now();
  const skew = input.skewMs ?? OAUTH2_REFRESH_SKEW_MS;
  return input.expiresAt <= now + skew;
};
