// ---------------------------------------------------------------------------
// @executor/plugin-oauth2 — generic OAuth 2.0 helpers
//
// Pure helpers for building authorization URLs, exchanging codes, and
// refreshing tokens against a standards-compliant OAuth 2.0 token endpoint.
// Plugins (google-discovery, openapi, ...) wrap these with their own
// session storage, secret management, and onboarding UI.
//
// Every public helper is intentionally provider-agnostic. Provider-specific
// query parameters (Google's `access_type=offline`, `prompt=consent`, etc.)
// are passed via the `extraParams` escape hatch so callers don't lose
// fidelity when switching from a hand-rolled implementation.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";

import { Data, Effect, ParseResult, Schema } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OAuth2Error extends Data.TaggedError("OAuth2Error")<{
  readonly message: string;
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
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------

const encodeBase64Url = (input: Buffer): string =>
  input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** Generate a 48-byte (64-char base64url) PKCE code verifier. */
export const createPkceCodeVerifier = (): string => encodeBase64Url(randomBytes(48));

/** Compute the S256 code challenge for a given verifier. */
export const createPkceCodeChallenge = (verifier: string): string =>
  encodeBase64Url(createHash("sha256").update(verifier).digest());

// ---------------------------------------------------------------------------
// Authorization URL builder
// ---------------------------------------------------------------------------

export type BuildAuthorizationUrlInput = {
  readonly authorizationUrl: string;
  readonly clientId: string;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly codeVerifier: string;
  /** Separator between scopes. RFC 6749 says space; some providers use comma. */
  readonly scopeSeparator?: string;
  /**
   * Provider-specific extra params (e.g. Google's `access_type=offline`,
   * `prompt=consent`, `include_granted_scopes=true`). Merged AFTER the
   * standard params so callers can override if absolutely necessary.
   */
  readonly extraParams?: Readonly<Record<string, string>>;
};

export const buildAuthorizationUrl = (input: BuildAuthorizationUrlInput): string => {
  const url = new URL(input.authorizationUrl);
  const separator = input.scopeSeparator ?? " ";
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(separator));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", createPkceCodeChallenge(input.codeVerifier));
  if (input.extraParams) {
    for (const [k, v] of Object.entries(input.extraParams)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
};

// ---------------------------------------------------------------------------
// Token endpoint response parsing
// ---------------------------------------------------------------------------

const oauth2Error = (message: string, cause?: unknown): OAuth2Error =>
  new OAuth2Error({ message, cause });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * `expires_in` per RFC 6749 is a number of seconds, but some providers
 * (Azure, older OAuth servers) return it as a string. Accept either and
 * coerce to number.
 */
const TokenExpirySeconds = Schema.transformOrFail(
  Schema.Union(Schema.Number, Schema.String),
  Schema.Number,
  {
    strict: true,
    decode: (input, _options, ast) => {
      if (typeof input === "number") return ParseResult.succeed(input);
      const parsed = Number(input);
      return Number.isFinite(parsed)
        ? ParseResult.succeed(parsed)
        : ParseResult.fail(
            new ParseResult.Type(ast, input, `expires_in "${input}" is not a number`),
          );
    },
    encode: (value) => ParseResult.succeed(value),
  },
);

const OAuth2TokenSuccessSchema = Schema.Struct({
  /** RFC 6749 §5.1 requires a non-empty access_token on success. */
  access_token: Schema.String.pipe(Schema.minLength(1)),
  token_type: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(TokenExpirySeconds),
  scope: Schema.optional(Schema.String),
});

/** RFC 6749 §5.2 error response envelope — all fields optional; we probe them. */
const OAuth2ErrorEnvelopeSchema = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const decodeSuccessBody = Schema.decodeUnknown(OAuth2TokenSuccessSchema);
const decodeErrorBody = Schema.decodeUnknown(OAuth2ErrorEnvelopeSchema);

/**
 * Parse the body of a token endpoint Response as JSON and ensure it's a
 * plain object. Fails with `OAuth2Error` whose message matches the
 * historical wording (`non-JSON response (${status})` /
 * `invalid JSON payload (${status})`) so callers keep their fidelity
 * guarantees.
 */
const parseJsonObject = (
  rawText: string,
  status: number,
): Effect.Effect<Record<string, unknown>, OAuth2Error> =>
  Effect.try({
    try: () => JSON.parse(rawText) as unknown,
    catch: () => oauth2Error(`OAuth token endpoint returned non-JSON response (${status})`),
  }).pipe(
    Effect.flatMap((parsed) =>
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? Effect.succeed(parsed as Record<string, unknown>)
        : Effect.fail(
            oauth2Error(`OAuth token endpoint returned invalid JSON payload (${status})`),
          ),
    ),
  );

/**
 * Parse a `Response` from an OAuth 2.0 token endpoint into an
 * `OAuth2TokenResponse`. Failures surface through the Effect failure
 * channel as `OAuth2Error`.
 *
 * Handles, in order, the failure modes we have seen in the wild:
 *   1. Non-JSON bodies (HTML error pages from misconfigured proxies / 5xx)
 *   2. JSON arrays / primitives instead of an object
 *   3. RFC 6749 error responses (`error_description` → `error` → `status N`)
 *   4. 200 responses with empty / missing `access_token`
 *   5. `expires_in` returned as a string instead of a number (Azure et al.)
 */
export const decodeTokenResponse = (
  response: Response,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.gen(function* () {
    const rawText = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        oauth2Error(
          `Failed to read OAuth token endpoint body: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        ),
    });

    const record = yield* parseJsonObject(rawText, response.status);

    if (!response.ok) {
      // Probe the error envelope. A body that doesn't match the envelope
      // (e.g. completely empty) is not itself a failure — we just fall
      // back to `status N`. This mirrors the tolerant behavior of the
      // prior hand-rolled parser.
      const envelope = yield* decodeErrorBody(record).pipe(
        Effect.catchAll(() => Effect.succeed({} as { error?: string; error_description?: string })),
      );
      const description =
        envelope.error_description ?? envelope.error ?? `status ${response.status}`;
      return yield* Effect.fail(oauth2Error(`OAuth token exchange failed: ${description}`));
    }

    return yield* decodeSuccessBody(record).pipe(
      Effect.mapError(() =>
        // The only schema constraint that can fail on a 2xx is "access_token
        // is a non-empty string". Any other shape mismatch (wrong type on an
        // optional field, malformed expires_in) also surfaces as the same
        // message — we deliberately fold them together: the user needs an
        // access token, and they didn't get one.
        oauth2Error("OAuth token endpoint did not return an access_token"),
      ),
    );
  });

// ---------------------------------------------------------------------------
// Token endpoint POST
// ---------------------------------------------------------------------------

export type ClientAuthMethod = "body" | "basic";

const buildClientAuthHeaders = (
  clientId: string,
  clientSecret: string | null | undefined,
  method: ClientAuthMethod,
): Record<string, string> => {
  if (method !== "basic" || !clientSecret) return {};
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return { authorization: `Basic ${encoded}` };
};

const applyClientAuthBody = (
  body: URLSearchParams,
  clientId: string,
  clientSecret: string | null | undefined,
  method: ClientAuthMethod,
): void => {
  if (method === "basic") return;
  body.set("client_id", clientId);
  if (clientSecret) body.set("client_secret", clientSecret);
};

const postToTokenEndpoint = (input: {
  readonly tokenUrl: string;
  readonly body: URLSearchParams;
  readonly extraHeaders: Record<string, string>;
  readonly timeoutMs: number;
}): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.tryPromise({
    try: () =>
      fetch(input.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          ...input.extraHeaders,
        },
        body: input.body,
        signal: AbortSignal.timeout(input.timeoutMs),
      }),
    catch: (cause) => oauth2Error(cause instanceof Error ? cause.message : String(cause), cause),
  }).pipe(Effect.flatMap(decodeTokenResponse));

// ---------------------------------------------------------------------------
// Exchange authorization code → tokens
// ---------------------------------------------------------------------------

export type ExchangeAuthorizationCodeInput = {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly redirectUrl: string;
  readonly codeVerifier: string;
  readonly code: string;
  /** "body" (default) sends client creds in the form body; "basic" uses HTTP Basic. */
  readonly clientAuth?: ClientAuthMethod;
  readonly timeoutMs?: number;
};

export const exchangeAuthorizationCode = (
  input: ExchangeAuthorizationCodeInput,
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> => {
  const clientAuth = input.clientAuth ?? "body";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    redirect_uri: input.redirectUrl,
    code_verifier: input.codeVerifier,
    code: input.code,
  });
  applyClientAuthBody(body, input.clientId, input.clientSecret, clientAuth);
  return postToTokenEndpoint({
    tokenUrl: input.tokenUrl,
    body,
    extraHeaders: buildClientAuthHeaders(input.clientId, input.clientSecret, clientAuth),
    timeoutMs: input.timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS,
  });
};

// ---------------------------------------------------------------------------
// Refresh access token
// ---------------------------------------------------------------------------

export type RefreshAccessTokenInput = {
  readonly tokenUrl: string;
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
): Effect.Effect<OAuth2TokenResponse, OAuth2Error> => {
  const clientAuth = input.clientAuth ?? "body";
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  applyClientAuthBody(body, input.clientId, input.clientSecret, clientAuth);
  if (input.scopes && input.scopes.length > 0) {
    body.set("scope", input.scopes.join(input.scopeSeparator ?? " "));
  }
  return postToTokenEndpoint({
    tokenUrl: input.tokenUrl,
    body,
    extraHeaders: buildClientAuthHeaders(input.clientId, input.clientSecret, clientAuth),
    timeoutMs: input.timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS,
  });
};

// ---------------------------------------------------------------------------
// Refresh-needed predicate
// ---------------------------------------------------------------------------

/**
 * Returns true iff the current time is within `OAUTH2_REFRESH_SKEW_MS` of
 * `expiresAt`. A null `expiresAt` (server didn't return `expires_in`) means
 * we cannot proactively refresh — callers should fall back to reactive
 * refresh on 401 responses.
 */
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

// ---------------------------------------------------------------------------
// Re-exports from sibling modules
// ---------------------------------------------------------------------------

export {
  type OAuth2AuthRefs,
  type OAuth2SecretsIO,
  type RefreshedAuthSnapshot,
  type StoreOAuthTokensInput,
  type StoredOAuthTokens,
  type WithRefreshedAccessTokenInput,
  storeOAuthTokens,
  withRefreshedAccessToken,
} from "./refresh";
