// ---------------------------------------------------------------------------
// Shared OAuth HTTP API — one endpoint set per flow, served at
// `/scopes/:scopeId/oauth/{probe,start,complete,callback}` for every
// plugin that needs OAuth. `pluginId` lives on the request body so the
// completion callback can route to the right plugin at persist time.
// Replaces the four per-plugin copies that lived under
// `/scopes/:scopeId/{mcp,openapi,graphql,google-discovery}/oauth/*`.
// ---------------------------------------------------------------------------

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

import {
  OAuthCompleteError,
  OAuthProbeError,
  OAuthSessionNotFoundError,
  OAuthStartError,
  OAuthStrategySchema,
  ScopeId,
} from "@executor/sdk";

import { InternalError } from "../observability";

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);

// ---------------------------------------------------------------------------
// Probe — decide between dynamic-DCR and paste-your-credentials flows
// ---------------------------------------------------------------------------

const ProbePayload = Schema.Struct({
  endpoint: Schema.String,
});

const ProbeResponse = Schema.Struct({
  resourceMetadata: Schema.NullOr(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  authorizationServerMetadata: Schema.NullOr(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
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

const StartPayload = Schema.Struct({
  /** Resource URL — used by probe/display, not by the start flow for
   *  static strategies. */
  endpoint: Schema.String,
  /** Where the authorization server will bounce the user's browser
   *  back to. Pass a placeholder (e.g. the token URL) for flows that
   *  don't redirect; the service still persists it. */
  redirectUrl: Schema.String,
  /** Stable id the Connection the exchange will mint. Caller typically
   *  derives this as `${pluginId}-oauth2-${namespace}` so the source
   *  row can be stamped atomically with the flow start. */
  connectionId: Schema.String,
  /** Scope where the resulting Connection + its backing secrets land. */
  tokenScope: Schema.optional(Schema.String),
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
  completedConnection: Schema.NullOr(
    Schema.Struct({ connectionId: Schema.String }),
  ),
});

// ---------------------------------------------------------------------------
// Complete — exchange the code, mint the Connection, drop the session.
// ---------------------------------------------------------------------------

const CompletePayload = Schema.Struct({
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

const CancelPayload = Schema.Struct({
  sessionId: Schema.String,
});

const CancelResponse = Schema.Struct({
  cancelled: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// OAuth callback — GET with `state` + `code` (or `error`) query params.
// Renders the popup HTML directly; the popup script posts the completion
// result back to the opener via `postMessage` / `BroadcastChannel`.
// ---------------------------------------------------------------------------

const CallbackUrlParams = Schema.Struct({
  state: Schema.String,
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const HtmlResponse = Schema.Unknown.annotations(
  HttpApiSchema.annotations({ contentType: "text/html" }),
);

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class OAuthApi extends HttpApiGroup.make("oauth")
  .add(
    HttpApiEndpoint.post("probe")`/scopes/${scopeIdParam}/oauth/probe`
      .setPayload(ProbePayload)
      .addSuccess(ProbeResponse),
  )
  .add(
    HttpApiEndpoint.post("start")`/scopes/${scopeIdParam}/oauth/start`
      .setPayload(StartPayload)
      .addSuccess(StartResponse),
  )
  .add(
    HttpApiEndpoint.post("complete")`/scopes/${scopeIdParam}/oauth/complete`
      .setPayload(CompletePayload)
      .addSuccess(CompleteResponse),
  )
  .add(
    HttpApiEndpoint.post("cancel")`/scopes/${scopeIdParam}/oauth/cancel`
      .setPayload(CancelPayload)
      .addSuccess(CancelResponse),
  )
  .add(
    HttpApiEndpoint.get("callback", "/oauth/callback")
      .setUrlParams(CallbackUrlParams)
      .addSuccess(HtmlResponse),
  )
  .addError(InternalError)
  .addError(OAuthProbeError)
  .addError(OAuthStartError)
  .addError(OAuthCompleteError)
  .addError(OAuthSessionNotFoundError) {}
