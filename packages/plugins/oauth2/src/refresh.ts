// ---------------------------------------------------------------------------
// Generic helpers for storing OAuth token secrets and transparently
// refreshing access tokens before a request.
//
// Plugins (google-discovery, openapi) supply an adapter for their secrets
// API and a `persistAuth` callback so this module stays decoupled from any
// specific plugin SDK or store shape.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { OAuth2Error, type OAuth2TokenResponse } from "./index";
import {
  OAUTH2_DEFAULT_TIMEOUT_MS,
  refreshAccessToken,
  shouldRefreshToken,
  type ClientAuthMethod,
} from "./index";

// ---------------------------------------------------------------------------
// Secrets I/O adapter — plain string IDs, no plugin types.
// ---------------------------------------------------------------------------

export type OAuth2SecretsIO = {
  readonly resolve: (secretId: string) => Effect.Effect<string, unknown>;
  readonly setValue: (input: {
    readonly secretId: string;
    readonly value: string;
    readonly name: string;
    readonly purpose: string;
  }) => Effect.Effect<void, unknown>;
};

const wrapSecretError =
  (operation: string) =>
  (cause: unknown): OAuth2Error =>
    new OAuth2Error({
      message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    });

// ---------------------------------------------------------------------------
// storeOAuthTokens — freshly store access + refresh tokens as new secrets.
// ---------------------------------------------------------------------------

/** Shape of a newly persisted OAuth2 auth descriptor. */
export type StoredOAuthTokens = {
  readonly accessTokenSecretId: string;
  readonly refreshTokenSecretId: string | null;
  readonly tokenType: string;
  readonly expiresAt: number | null;
  readonly scope: string | null;
};

export type StoreOAuthTokensInput = {
  readonly tokens: OAuth2TokenResponse;
  /** Slug used as prefix for new secret IDs, e.g. `acme_api`. */
  readonly slug: string;
  /** Human-readable name for the source, used in secret labels. */
  readonly displayName: string;
  /** `purpose` label stored on the access-token secret. */
  readonly accessTokenPurpose: string;
  /** `purpose` label stored on the refresh-token secret. */
  readonly refreshTokenPurpose: string;
  /** Adapter that creates a new secret and returns its freshly-minted ID. */
  readonly createSecret: (input: {
    readonly idPrefix: string;
    readonly name: string;
    readonly value: string;
    readonly purpose: string;
  }) => Effect.Effect<{ readonly id: string }, unknown>;
};

/**
 * Persist access + refresh tokens from an OAuth2 token response as new
 * secrets and return a `StoredOAuthTokens` descriptor ready to write to a
 * source config.
 */
export const storeOAuthTokens = (
  input: StoreOAuthTokensInput,
): Effect.Effect<StoredOAuthTokens, OAuth2Error> =>
  Effect.gen(function* () {
    const accessRef = yield* input
      .createSecret({
        idPrefix: `${input.slug}_access_token`,
        name: `${input.displayName} Access Token`,
        value: input.tokens.access_token,
        purpose: input.accessTokenPurpose,
      })
      .pipe(Effect.mapError(wrapSecretError("Failed to store access token")));

    const refreshRef = input.tokens.refresh_token
      ? yield* input
          .createSecret({
            idPrefix: `${input.slug}_refresh_token`,
            name: `${input.displayName} Refresh Token`,
            value: input.tokens.refresh_token,
            purpose: input.refreshTokenPurpose,
          })
          .pipe(Effect.mapError(wrapSecretError("Failed to store refresh token")))
      : null;

    return {
      accessTokenSecretId: accessRef.id,
      refreshTokenSecretId: refreshRef?.id ?? null,
      tokenType: input.tokens.token_type ?? "Bearer",
      expiresAt:
        typeof input.tokens.expires_in === "number"
          ? Date.now() + input.tokens.expires_in * 1000
          : null,
      scope: input.tokens.scope ?? null,
    };
  });

// ---------------------------------------------------------------------------
// withRefreshedAccessToken — return the current access token, refreshing
// first if it's within the skew window.
// ---------------------------------------------------------------------------

/** The subset of a stored OAuth2 auth descriptor this helper needs. */
export type OAuth2AuthRefs = {
  readonly clientIdSecretId: string;
  readonly clientSecretSecretId: string | null;
  readonly accessTokenSecretId: string;
  readonly refreshTokenSecretId: string | null;
  readonly tokenType: string;
  readonly expiresAt: number | null;
  readonly scopes: readonly string[];
};

/** Snapshot of auth values written back after a successful refresh. */
export type RefreshedAuthSnapshot = {
  readonly tokenType: string;
  readonly expiresAt: number | null;
  readonly scope: string | null;
};

export type WithRefreshedAccessTokenInput = {
  readonly auth: OAuth2AuthRefs;
  readonly tokenUrl: string;
  readonly secrets: OAuth2SecretsIO;
  /** Display name used when re-setting the access-token secret after refresh. */
  readonly displayName: string;
  readonly accessTokenPurpose: string;
  readonly refreshTokenPurpose: string;
  readonly clientAuth?: ClientAuthMethod;
  readonly timeoutMs?: number;
  /**
   * Called after a successful refresh with the new expiry / tokenType /
   * scope so the plugin can write the updated auth back to its source
   * config. The accessTokenSecretId does NOT change — the value behind
   * it is overwritten in place.
   */
  readonly persistAuth: (
    snapshot: RefreshedAuthSnapshot,
  ) => Effect.Effect<void, unknown>;
};

/**
 * Resolve the current access token for a source — if it's within the
 * refresh-skew window, first exchange the refresh token for a new access
 * token, persist it, and write the updated expiry back via `persistAuth`.
 *
 * Returns the access-token string to be used for the upcoming request.
 */
export const withRefreshedAccessToken = (
  input: WithRefreshedAccessTokenInput,
): Effect.Effect<string, OAuth2Error> =>
  Effect.gen(function* () {
    const { auth, secrets } = input;
    const needsRefresh =
      auth.refreshTokenSecretId !== null && shouldRefreshToken({ expiresAt: auth.expiresAt });

    if (!needsRefresh) {
      return yield* secrets
        .resolve(auth.accessTokenSecretId)
        .pipe(Effect.mapError(wrapSecretError("Failed to resolve OAuth access token")));
    }

    // Proactive refresh path.
    const refreshToken = yield* secrets
      .resolve(auth.refreshTokenSecretId!)
      .pipe(Effect.mapError(wrapSecretError("Failed to resolve OAuth refresh token")));

    const clientId = yield* secrets
      .resolve(auth.clientIdSecretId)
      .pipe(Effect.mapError(wrapSecretError("Failed to resolve OAuth client ID")));

    const clientSecret =
      auth.clientSecretSecretId === null
        ? null
        : yield* secrets
            .resolve(auth.clientSecretSecretId)
            .pipe(Effect.mapError(wrapSecretError("Failed to resolve OAuth client secret")));

    const refreshed = yield* refreshAccessToken({
      tokenUrl: input.tokenUrl,
      clientId,
      clientSecret,
      refreshToken,
      scopes: auth.scopes,
      clientAuth: input.clientAuth,
      timeoutMs: input.timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS,
    });

    yield* secrets
      .setValue({
        secretId: auth.accessTokenSecretId,
        value: refreshed.access_token,
        name: `${input.displayName} Access Token`,
        purpose: input.accessTokenPurpose,
      })
      .pipe(Effect.mapError(wrapSecretError("Failed to persist refreshed access token")));

    if (refreshed.refresh_token && auth.refreshTokenSecretId) {
      yield* secrets
        .setValue({
          secretId: auth.refreshTokenSecretId,
          value: refreshed.refresh_token,
          name: `${input.displayName} Refresh Token`,
          purpose: input.refreshTokenPurpose,
        })
        .pipe(Effect.mapError(wrapSecretError("Failed to persist rotated refresh token")));
    }

    yield* input
      .persistAuth({
        tokenType: refreshed.token_type ?? auth.tokenType,
        expiresAt:
          typeof refreshed.expires_in === "number"
            ? Date.now() + refreshed.expires_in * 1000
            : auth.expiresAt,
        scope: refreshed.scope ?? null,
      })
      .pipe(Effect.mapError(wrapSecretError("Failed to persist updated OAuth auth")));

    return refreshed.access_token;
  });
