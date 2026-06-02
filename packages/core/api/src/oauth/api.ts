// ---------------------------------------------------------------------------
// Shared OAuth HTTP API — one endpoint set per flow, served at
// `/scopes/:scopeId/oauth/{probe,start,complete,callback}` for every
// plugin that needs OAuth. `pluginId` lives on the request body so the
// completion callback can route to the right plugin at persist time.
// Replaces the per-plugin copies that lived under
// `/scopes/:scopeId/{mcp,openapi,graphql}/oauth/*`.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";

import {
  InternalError,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthSessionNotFoundError,
  OAuthStartError,
  OAuthStrategySchema,
  ScopeId,
  SecretBackedMap,
} from "@executor-js/sdk/shared";

const ScopeParams = { scopeId: ScopeId };
// ---------------------------------------------------------------------------
// Probe — decide between dynamic-DCR and paste-your-credentials flows
// ---------------------------------------------------------------------------

export const ProbePayload = Schema.Struct({
  endpoint: Schema.String,
  headers: Schema.optional(SecretBackedMap),
  queryParams: Schema.optional(SecretBackedMap),
});

const ProbeResponse = Schema.Struct({
  resourceMetadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerMetadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  authorizationServerMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerUrl: Schema.NullOr(Schema.String),
  supportsDynamicRegistration: Schema.Boolean,
  isBearerChallengeEndpoint: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// Start — persists an `oauth2_session` row; for user-interactive flows
// returns an authorization URL, for `client-credentials` mints the
// Connection inline and returns it under `completedConnection`.
// ---------------------------------------------------------------------------

export const StartPayload = Schema.Struct({
  /** Resource URL — used by probe/display, not by the start flow for
   *  static strategies. */
  endpoint: Schema.String,
  headers: Schema.optional(SecretBackedMap),
  queryParams: Schema.optional(SecretBackedMap),
  /** Where the authorization server will bounce the user's browser
   *  back to. Pass a placeholder (e.g. the token URL) for flows that
   *  don't redirect; the service still persists it. */
  redirectUrl: Schema.String,
  /** Stable id the Connection the exchange will mint. Caller typically
   *  derives this as `${pluginId}-oauth2-${namespace}` so the source
   *  row can be stamped atomically with the flow start. */
  connectionId: Schema.String,
  /** Scope where the resulting Connection + its backing secrets land. */
  tokenScope: Schema.String,
  strategy: OAuthStrategySchema,
  /** Which plugin is initiating the flow. Persisted on the session +
   *  stamped on the minted Connection's identity-label prefix. */
  pluginId: Schema.String,
  /** Human label for the minted Connection. */
  identityLabel: Schema.optional(Schema.String),
});

const StartResponse = Schema.Struct({
  sessionId: Schema.String,
  /** Present for user-interactive strategies. `null` for
   *  `client-credentials` (no redirect). */
  authorizationUrl: Schema.NullOr(Schema.String),
  /** Filled for strategies that mint the Connection inline. */
  completedConnection: Schema.NullOr(Schema.Struct({ connectionId: Schema.String })),
});

// ---------------------------------------------------------------------------
// Complete — exchange the code, mint the Connection, drop the session.
// ---------------------------------------------------------------------------

export const CompletePayload = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

const CompleteResponse = Schema.Struct({
  connectionId: Schema.String,
  expiresAt: Schema.NullOr(Schema.Number),
  scope: Schema.NullOr(Schema.String),
});

// ---------------------------------------------------------------------------
// Cancel — drop an in-flight session without exchanging.
// ---------------------------------------------------------------------------

export const CancelPayload = Schema.Struct({
  sessionId: Schema.String,
  /** Scope that owns the pending OAuth session. Must match start.tokenScope. */
  tokenScope: Schema.String,
});

const CancelResponse = Schema.Struct({
  cancelled: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// OAuth callback — GET with `state` + `code` (or `error`) query params.
// Renders the popup HTML directly; the popup script posts the completion
// result back to the opener via `postMessage` / `BroadcastChannel`.
// ---------------------------------------------------------------------------

export const CallbackUrlParams = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const HtmlResponse = Schema.String.pipe(HttpApiSchema.asText());

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const OAuthApi = HttpApiGroup.make("oauth")
  .add(
    HttpApiEndpoint.post("probe", "/scopes/:scopeId/oauth/probe", {
      params: ScopeParams,
      payload: ProbePayload,
      success: ProbeResponse,
      error: [InternalError, OAuthProbeError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "oauth.probe",
        summary: "Probe OAuth Endpoint",
        description:
          "Probes an endpoint to discover its OAuth resource and authorization server metadata and whether it supports dynamic client registration.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("start", "/scopes/:scopeId/oauth/start", {
      params: ScopeParams,
      payload: StartPayload,
      success: StartResponse,
      error: [InternalError, OAuthStartError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "oauth.start",
        summary: "Start OAuth Flow",
        description:
          "Starts an OAuth flow by persisting a session and returning an authorization URL, or minting the connection inline for client-credentials strategies.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("complete", "/scopes/:scopeId/oauth/complete", {
      params: ScopeParams,
      payload: CompletePayload,
      success: CompleteResponse,
      error: [InternalError, OAuthCompleteError, OAuthSessionNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "oauth.complete",
        summary: "Complete OAuth Flow",
        description:
          "Completes an OAuth flow by exchanging the authorization code for tokens, minting the connection, and dropping the session.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("cancel", "/scopes/:scopeId/oauth/cancel", {
      params: ScopeParams,
      payload: CancelPayload,
      success: CancelResponse,
      error: [InternalError, OAuthSessionNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "oauth.cancel",
        summary: "Cancel OAuth Flow",
        description:
          "Cancels an in-flight OAuth session without exchanging the authorization code.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("callback", "/oauth/callback", {
      query: CallbackUrlParams,
      success: HtmlResponse,
      error: [InternalError, OAuthCompleteError, OAuthSessionNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "oauth.callback",
        summary: "OAuth Redirect Callback",
        description:
          "Handles the OAuth redirect with state and code query params and renders popup HTML that posts the completion result back to the opener.",
      }),
    ),
  );
