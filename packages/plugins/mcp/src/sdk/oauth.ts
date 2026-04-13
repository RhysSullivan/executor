// ---------------------------------------------------------------------------
// MCP OAuth flow — start authorization + exchange code for tokens
// ---------------------------------------------------------------------------

import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Effect, Schema } from "effect";
import { McpOAuthError } from "./errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });
type JsonObject = typeof JsonObject.Type;

/** Discovery + client state persisted between start and exchange */
export const McpOAuthDiscoveryState = Schema.Struct({
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerUrl: Schema.NullOr(Schema.String),
  resourceMetadata: Schema.NullOr(JsonObject),
  authorizationServerMetadata: Schema.NullOr(JsonObject),
  clientInformation: Schema.NullOr(JsonObject),
});
export type McpOAuthDiscoveryState = typeof McpOAuthDiscoveryState.Type;

/** Pending OAuth session persisted between startOAuth and completeOAuth */
export const McpOAuthSession = Schema.Struct({
  ...McpOAuthDiscoveryState.fields,
  endpoint: Schema.String,
  redirectUrl: Schema.String,
  codeVerifier: Schema.String,
});
export type McpOAuthSession = typeof McpOAuthSession.Type;

export interface McpOAuthStartResult extends McpOAuthDiscoveryState {
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
}

export interface McpOAuthExchangeResult extends McpOAuthDiscoveryState {
  readonly tokens: OAuthTokens;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const toJsonObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const CLIENT_METADATA = {
  grant_types: ["authorization_code", "refresh_token"] as string[],
  response_types: ["code"] as string[],
  token_endpoint_auth_method: "none" as const,
  client_name: "Executor",
};

const extractDiscoveryState = (
  discoveryState: OAuthDiscoveryState | undefined,
  clientInformation: OAuthClientInformationMixed | undefined,
): McpOAuthDiscoveryState => ({
  resourceMetadataUrl: discoveryState?.resourceMetadataUrl ?? null,
  authorizationServerUrl: discoveryState?.authorizationServerUrl ?? null,
  resourceMetadata: toJsonObject(discoveryState?.resourceMetadata),
  authorizationServerMetadata: toJsonObject(discoveryState?.authorizationServerMetadata),
  clientInformation: toJsonObject(clientInformation),
});

const callAuth = (provider: OAuthClientProvider, opts: Parameters<typeof auth>[1]) =>
  Effect.tryPromise({
    try: () => auth(provider, opts),
    catch: (cause) =>
      new McpOAuthError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

// ---------------------------------------------------------------------------
// Start — initiate the authorization flow, get a redirect URL
// ---------------------------------------------------------------------------

export const startMcpOAuthAuthorization = (input: {
  endpoint: string;
  redirectUrl: string;
  state: string;
}): Effect.Effect<McpOAuthStartResult, McpOAuthError> =>
  Effect.gen(function* () {
    let authorizationUrl: URL | undefined;
    let codeVerifier: string | undefined;
    let discoveryState: OAuthDiscoveryState | undefined;
    let clientInformation: OAuthClientInformationMixed | undefined;

    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return input.redirectUrl;
      },
      get clientMetadata() {
        return { ...CLIENT_METADATA, redirect_uris: [input.redirectUrl] };
      },
      state: () => input.state,
      clientInformation: () => clientInformation,
      saveClientInformation: (ci) => {
        clientInformation = ci;
      },
      tokens: () => undefined,
      saveTokens: () => undefined,
      redirectToAuthorization: (url) => {
        authorizationUrl = url;
      },
      saveCodeVerifier: (cv) => {
        codeVerifier = cv;
      },
      codeVerifier: () => {
        if (!codeVerifier) throw new Error("Code verifier not captured");
        return codeVerifier;
      },
      saveDiscoveryState: (s) => {
        discoveryState = s;
      },
      discoveryState: () => discoveryState,
    };

    const result = yield* callAuth(provider, { serverUrl: input.endpoint });

    if (result !== "REDIRECT" || !authorizationUrl || !codeVerifier) {
      return yield* new McpOAuthError({
        message: "OAuth flow did not produce an authorization redirect",
      });
    }

    return {
      authorizationUrl: authorizationUrl.toString(),
      codeVerifier,
      ...extractDiscoveryState(discoveryState, clientInformation),
    };
  });

// ---------------------------------------------------------------------------
// Exchange — trade an authorization code for tokens
// ---------------------------------------------------------------------------

export const exchangeMcpOAuthCode = (input: {
  session: McpOAuthSession;
  code: string;
}): Effect.Effect<McpOAuthExchangeResult, McpOAuthError> =>
  Effect.gen(function* () {
    const { session } = input;

    let tokens: OAuthTokens | undefined;
    let discoveryState: OAuthDiscoveryState | undefined = {
      authorizationServerUrl:
        session.authorizationServerUrl ?? new URL("/", session.endpoint).toString(),
      resourceMetadataUrl: session.resourceMetadataUrl ?? undefined,
      resourceMetadata: session.resourceMetadata as OAuthDiscoveryState["resourceMetadata"],
      authorizationServerMetadata:
        session.authorizationServerMetadata as OAuthDiscoveryState["authorizationServerMetadata"],
    };
    let clientInformation = session.clientInformation as OAuthClientInformationMixed | undefined;

    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return session.redirectUrl;
      },
      get clientMetadata() {
        return { ...CLIENT_METADATA, redirect_uris: [session.redirectUrl] };
      },
      clientInformation: () => clientInformation,
      saveClientInformation: (ci) => {
        clientInformation = ci;
      },
      tokens: () => undefined,
      saveTokens: (t) => {
        tokens = t;
      },
      redirectToAuthorization: () => {
        throw new Error("Unexpected redirect during code exchange");
      },
      saveCodeVerifier: () => undefined,
      codeVerifier: () => session.codeVerifier,
      saveDiscoveryState: (s) => {
        discoveryState = s;
      },
      discoveryState: () => discoveryState,
    };

    const result = yield* callAuth(provider, {
      serverUrl: session.endpoint,
      authorizationCode: input.code,
    });

    if (result !== "AUTHORIZED" || !tokens) {
      return yield* new McpOAuthError({
        message: "OAuth exchange did not produce tokens",
      });
    }

    return {
      tokens,
      ...extractDiscoveryState(discoveryState, clientInformation),
    };
  });
