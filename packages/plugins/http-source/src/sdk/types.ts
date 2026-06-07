import { Schema } from "effect";

import type { AuthTemplateSlug, Integration, OAuthAuthentication } from "@executor-js/sdk/shared";

/* ───────────────────────  template variables  ───────────────────────
 * Brought over from the v2 openapi scaffold (packages/sdk-v2/src/openapi/
 * types.ts). The apiKey template declares WHERE a connection's resolved value
 * is placed on the outbound request (header / query) using `variable()` refs.
 * That placement is HTTP-transport-specific, which is why it lives with the
 * http plugin and not core. The oauth template is mechanism-intrinsic and comes
 * from core (`OAuthAuthentication`). An integration's `Authentication` union
 * composes the two — and an OAuth access token renders through the (oauth)
 * template exactly like an apiKey bearer (D11). */

export interface AuthenticationVariable {
  readonly type: "variable";
  readonly name: string;
}

/** A literal string, or a parts-array mixing literals and variable refs. */
export type AuthenticationTemplateValue = string | readonly (string | AuthenticationVariable)[];

export const variable = (name: string): AuthenticationVariable => ({
  type: "variable",
  name,
});

/** The conventional variable name an http auth template renders the connection's
 *  resolved credential value into. `applyAuthTemplate` substitutes this. */
export const CREDENTIAL_VARIABLE = "token";

export interface APIKeyAuthentication {
  readonly slug: AuthTemplateSlug;
  readonly type: "apiKey";
  readonly headers?: Record<string, AuthenticationTemplateValue>;
  readonly queryParams?: Record<string, AuthenticationTemplateValue>;
}

export type Authentication = OAuthAuthentication | APIKeyAuthentication;

/* ───────────────────────  http integration config  ───────────────────────
 * The opaque plugin config core stores on an http-source integration row. Core
 * never parses it; the plugin reads it back in `resolveTools` (to produce the
 * connection's request tool) and `invokeTool` (to render the auth template). */

export interface HttpSourceConfig {
  /** Base URL the connection's requests are issued against (e.g.
   *  `https://api.example.com`). A tool call's `path` is appended to it. */
  readonly baseUrl: string;
  /** Auth methods this integration declares. A connection picks one by `template`
   *  slug; `invokeTool` renders it with the connection's resolved value. */
  readonly authenticationTemplate: readonly Authentication[];
  /** Optional default headers applied to every request (non-secret). */
  readonly defaultHeaders?: Record<string, string>;
}

/* ───────────────────────  request tool wire schemas  ───────────────────────
 * Raw-HTTP tools take an explicit request envelope. Spec-derived plugins
 * (openapi) shape one tool per operation; the http kind exposes a single
 * generic `request` tool whose schema is identical per connection. */

export const HttpMethod = Schema.Literals([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type HttpMethod = typeof HttpMethod.Type;

export const HttpRequestArgs = Schema.Struct({
  method: HttpMethod.pipe(Schema.optional),
  /** Path appended to the integration's `baseUrl`. May be absolute. */
  path: Schema.String,
  query: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  /** Request body. Objects are JSON-encoded; strings pass through. */
  body: Schema.Unknown.pipe(Schema.optional),
}).annotate({ identifier: "HttpRequestArgs" });
export type HttpRequestArgs = typeof HttpRequestArgs.Type;

export const HttpResponse = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Unknown,
}).annotate({ identifier: "HttpResponse" });
export type HttpResponse = typeof HttpResponse.Type;

/* ───────────────────────  the integration projection  ───────────────────────
 * Extends the core `Integration` identity with the auth templates a provider
 * declares — the http-kind type-specific shape. Core never references it. */

export type HttpSourceIntegration = Integration & {
  readonly authenticationTemplate: readonly Authentication[];
};
