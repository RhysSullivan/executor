import { Option, Schema } from "effect";

import type { Authentication, AuthenticationTemplateValue, AuthenticationVariable } from "./types";
import { TOKEN_VARIABLE } from "./types";

// ---------------------------------------------------------------------------
// OpenAPI integration config — the opaque blob stored on the catalog
// `integration.config` column (D1). Core never parses it; the plugin writes it
// at register time and reads it back in `resolveTools` / `invokeTool`.
//
// In v2 there are NO credential bindings, NO per-source secret slots, and NO
// StoredSource credential config. The config carries only:
//   - the OpenAPI spec text (inlined) OR the source URL to (re)fetch from,
//   - the optional base URL override,
//   - the auth templates a connection's value is rendered through.
// ---------------------------------------------------------------------------

const AuthenticationVariableSchema = Schema.Struct({
  type: Schema.Literal("variable"),
  name: Schema.String,
});

const AuthenticationTemplateValueSchema = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([Schema.String, AuthenticationVariableSchema])),
]);

const APIKeyAuthenticationSchema = Schema.Struct({
  slug: Schema.String,
  type: Schema.Literal("apiKey"),
  headers: Schema.optional(Schema.Record(Schema.String, AuthenticationTemplateValueSchema)),
  queryParams: Schema.optional(Schema.Record(Schema.String, AuthenticationTemplateValueSchema)),
});

const OAuthAuthenticationSchema = Schema.Struct({
  slug: Schema.String,
  type: Schema.Literal("oauth"),
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  scopes: Schema.Array(Schema.String),
});

export const AuthenticationSchema = Schema.Union([
  OAuthAuthenticationSchema,
  APIKeyAuthenticationSchema,
]);

export const OpenApiIntegrationConfigSchema = Schema.Struct({
  /** Inlined OpenAPI document text (resolved + parsed source of truth). */
  spec: Schema.String,
  /** Origin URL the spec was fetched from, when known. Enables refresh. */
  sourceUrl: Schema.optional(Schema.String),
  /** Google Discovery bundle URLs, when the spec came from a Google bundle. */
  googleDiscoveryUrls: Schema.optional(Schema.Array(Schema.String)),
  /** Base URL override; falls back to the spec's first server. */
  baseUrl: Schema.optional(Schema.String),
  /** Static headers applied to every request (no secret material). */
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Static query params applied to every request (no secret material). */
  queryParams: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The auth methods a connection's value can be applied through. */
  authenticationTemplate: Schema.optional(Schema.Array(AuthenticationSchema)),
});

export type OpenApiIntegrationConfig = Omit<
  typeof OpenApiIntegrationConfigSchema.Type,
  "authenticationTemplate"
> & {
  /** Branded over the schema's structural form so the template renderer can
   *  treat `slug` as an `AuthTemplateSlug`. */
  readonly authenticationTemplate?: readonly Authentication[];
};

const decodeConfig = Schema.decodeUnknownOption(OpenApiIntegrationConfigSchema);

/** Decode the opaque integration config blob into the openapi shape.
 *  Returns null when the blob is missing/incompatible. */
export const decodeOpenApiIntegrationConfig = (value: unknown): OpenApiIntegrationConfig | null =>
  Option.getOrNull(decodeConfig(value)) as OpenApiIntegrationConfig | null;

// ---------------------------------------------------------------------------
// Template rendering — "auth state derived into the auth-template format"
// (D11). The resolved credential value renders into the template's
// `variable("token")` slots, identically for apiKey and oauth (the oauth value
// IS the access token). Returns the headers + query params to apply.
// ---------------------------------------------------------------------------

const isVariable = (part: string | AuthenticationVariable): part is AuthenticationVariable =>
  typeof part !== "string";

const renderTemplateValue = (
  template: AuthenticationTemplateValue,
  values: Record<string, string | null>,
): string => {
  if (typeof template === "string") return template;
  return template.map((part) => (isVariable(part) ? (values[part.name] ?? "") : part)).join("");
};

export interface RenderedAuth {
  readonly headers: Record<string, string>;
  readonly queryParams: Record<string, string>;
}

/** Render an auth template against a connection's resolved input `values`
 *  (`variable → value`). For an apiKey template, each `variable("<name>")` is
 *  substituted from its own entry, so a method with two distinct inputs (e.g.
 *  Datadog) fills each header from a different value. For an oauth template (no
 *  explicit placement), render a bearer Authorization header from `token`. */
export const renderAuthTemplate = (
  template: Authentication,
  values: Record<string, string | null>,
): RenderedAuth => {
  if (template.type === "oauth") {
    return {
      headers: { authorization: `Bearer ${values[TOKEN_VARIABLE] ?? ""}` },
      queryParams: {},
    };
  }
  const headers: Record<string, string> = {};
  const queryParams: Record<string, string> = {};
  for (const [name, tmpl] of Object.entries(template.headers ?? {})) {
    headers[name] = renderTemplateValue(tmpl, values);
  }
  for (const [name, tmpl] of Object.entries(template.queryParams ?? {})) {
    queryParams[name] = renderTemplateValue(tmpl, values);
  }
  return { headers, queryParams };
};

/** The distinct input variables a template references — the inputs a connection
 *  must supply. An oauth template needs `token`; an apiKey template needs every
 *  `variable("<name>")` across its placements. */
export const requiredTemplateVariables = (template: Authentication): readonly string[] => {
  if (template.type === "oauth") return [TOKEN_VARIABLE];
  const names = new Set<string>();
  const collect = (tmpl: AuthenticationTemplateValue): void => {
    if (typeof tmpl === "string") return;
    for (const part of tmpl) {
      if (isVariable(part)) names.add(part.name);
    }
  };
  for (const tmpl of Object.values(template.headers ?? {})) collect(tmpl);
  for (const tmpl of Object.values(template.queryParams ?? {})) collect(tmpl);
  return [...names];
};
