import type { AuthTemplateSlug } from "@executor-js/sdk/shared";

import {
  CREDENTIAL_VARIABLE,
  type APIKeyAuthentication,
  type Authentication,
  type AuthenticationTemplateValue,
} from "./types";

/* Render an integration's auth template onto an outbound request (D11: "auth
 * state derived into the auth-template format"). A connection resolves a MAP of
 * named inputs (`variable → value`); a single-secret connection has just
 * `{ token }`, an apiKey method with two distinct inputs (e.g. Datadog) one entry
 * per template variable. Each `variable("<name>")` renders from the matching map
 * entry — a refreshed OAuth access token is simply the `token` entry.
 *
 * Returns the headers + query params the template contributes. The plugin's
 * `invokeTool` merges these into the request it builds from the tool args. */

export interface RenderedAuth {
  readonly headers: Record<string, string>;
  readonly queryParams: Record<string, string>;
}

const EMPTY_AUTH: RenderedAuth = { headers: {}, queryParams: {} };

const renderTemplateValue = (
  parts: AuthenticationTemplateValue,
  values: Record<string, string | null>,
): string => {
  if (typeof parts === "string") return parts;
  let out = "";
  for (const part of parts) {
    if (typeof part === "string") {
      out += part;
    } else if (part.type === "variable") {
      // Each variable renders from its own input; an absent input renders empty.
      out += values[part.name] ?? "";
    }
  }
  return out;
};

/** Find the integration auth template a connection's `template` slug selects. */
export const findAuthTemplate = (
  templates: readonly Authentication[],
  slug: AuthTemplateSlug,
): Authentication | undefined =>
  templates.find((template: Authentication) => template.slug === slug);

/** The distinct input variables a template references — the credential inputs a
 *  connection must supply. An oauth template needs the single `token`; an apiKey
 *  template needs every `variable("<name>")` across its header/query placements. */
export const requiredVariables = (template: Authentication): readonly string[] => {
  if (template.type === "oauth") return [CREDENTIAL_VARIABLE];
  const names = new Set<string>();
  const collect = (parts: AuthenticationTemplateValue): void => {
    if (typeof parts === "string") return;
    for (const part of parts) {
      if (typeof part !== "string" && part.type === "variable") names.add(part.name);
    }
  };
  for (const parts of Object.values(template.headers ?? {})) collect(parts);
  for (const parts of Object.values(template.queryParams ?? {})) collect(parts);
  return [...names];
};

/** Render an `apiKey`/`oauth` template into request headers + query params using
 *  the connection's resolved input `values`. An oauth template carries no
 *  placement fields, so its access token (the `token` input) is applied as a
 *  conventional `Authorization: Bearer <token>` header — the "derived into
 *  template format" rendering. */
export const renderAuthTemplate = (
  template: Authentication | undefined,
  values: Record<string, string | null>,
): RenderedAuth => {
  if (template === undefined) return EMPTY_AUTH;

  if (template.type === "oauth") {
    const token = values[CREDENTIAL_VARIABLE];
    if (token == null) return EMPTY_AUTH;
    return {
      headers: { Authorization: `Bearer ${token}` },
      queryParams: {},
    };
  }

  const apiKey: APIKeyAuthentication = template;
  const headers: Record<string, string> = {};
  const queryParams: Record<string, string> = {};
  for (const [name, parts] of Object.entries(apiKey.headers ?? {})) {
    headers[name] = renderTemplateValue(parts, values);
  }
  for (const [name, parts] of Object.entries(apiKey.queryParams ?? {})) {
    queryParams[name] = renderTemplateValue(parts, values);
  }
  return { headers, queryParams };
};

/** Resolve the auth a connection contributes: pick its template by slug, render
 *  it with the resolved input values. */
export const applyAuthTemplate = (
  templates: readonly Authentication[],
  slug: AuthTemplateSlug,
  values: Record<string, string | null>,
): RenderedAuth => renderAuthTemplate(findAuthTemplate(templates, slug), values);
