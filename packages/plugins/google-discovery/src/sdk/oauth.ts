// ---------------------------------------------------------------------------
// Google-specific thin wrapper over @executor/plugin-oauth2.
//
// All standards-compliant OAuth 2.0 logic lives in the shared package. This
// file only carries the bits Google needs that are NOT in the spec:
//   - Hardcoded authorization URL (accounts.google.com/o/oauth2/v2/auth)
//   - access_type=offline                — required to receive a refresh_token
//   - prompt=consent                     — forces re-consent so refresh_token is reissued
//   - include_granted_scopes=true        — Google's incremental authorization
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import {
  buildAuthorizationUrl,
  createPkceCodeVerifier as sharedCreatePkceCodeVerifier,
  exchangeAuthorizationCode as sharedExchangeAuthorizationCode,
  type OAuth2TokenResponse,
} from "@executor/plugin-oauth2";

import { GoogleDiscoveryOAuthError } from "./errors";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GOOGLE_EXTRA_AUTHORIZATION_PARAMS = {
  access_type: "offline",
  include_granted_scopes: "true",
  prompt: "consent",
} as const;

export type { OAuth2TokenResponse as OAuth2TokenResponse };

export const createPkceCodeVerifier = sharedCreatePkceCodeVerifier;

export const buildGoogleAuthorizationUrl = (input: {
  readonly clientId: string;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly codeVerifier: string;
}): string =>
  buildAuthorizationUrl({
    authorizationUrl: GOOGLE_AUTHORIZATION_URL,
    clientId: input.clientId,
    redirectUrl: input.redirectUrl,
    scopes: input.scopes,
    state: input.state,
    codeVerifier: input.codeVerifier,
    extraParams: GOOGLE_EXTRA_AUTHORIZATION_PARAMS,
  });

const wrapError = <A>(
  effect: Effect.Effect<A, { readonly message: string }>,
): Effect.Effect<A, GoogleDiscoveryOAuthError> =>
  Effect.mapError(effect, (error) => new GoogleDiscoveryOAuthError({ message: error.message }));

export const exchangeAuthorizationCode = (input: {
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly redirectUrl: string;
  readonly codeVerifier: string;
  readonly code: string;
}): Effect.Effect<OAuth2TokenResponse, GoogleDiscoveryOAuthError> =>
  wrapError(
    sharedExchangeAuthorizationCode({
      tokenUrl: GOOGLE_TOKEN_URL,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      redirectUrl: input.redirectUrl,
      codeVerifier: input.codeVerifier,
      code: input.code,
    }),
  );

