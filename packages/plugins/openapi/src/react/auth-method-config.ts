// ---------------------------------------------------------------------------
// OpenAPI ↔ generic auth-method converters.
//
// The generic Accounts hub speaks in plugin-agnostic `AuthMethod` /
// `Placement` values (`@executor-js/react/lib/auth-placements`). The OpenAPI
// plugin stores auth as the HTTP-transport-specific `APIKeyAuthentication`
// template (header/query slots templated with `variable("token")`). These two
// converters bridge the wire template to/from the generic placement model, so
// they live with the OpenAPI plugin — they touch the openapi sdk
// `Authentication` types and would pull transport specifics into core.
// ---------------------------------------------------------------------------

import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";

import {
  TOKEN_VARIABLE,
  variable,
  type APIKeyAuthentication,
  type Authentication,
  type AuthenticationTemplateValue,
} from "../sdk/types";

// ---------------------------------------------------------------------------
// Template value → placement prefix.
//
// A header/query slot serializes the credential as `name -> [prefix, token]`,
// where `prefix` is the leading literal string before the `variable("token")`
// part. A bare `[token]` (or string-only) value has an empty prefix.
// ---------------------------------------------------------------------------

const isVariablePart = (part: string | { readonly type: "variable"; readonly name: string }) =>
  typeof part !== "string" && part.type === "variable";

/** Extract the literal prefix preceding the credential variable, plus the
 *  variable name that placement renders from (`token` for single-input methods,
 *  a distinct name per input for multi-input ones). */
const parseTemplateValue = (
  value: AuthenticationTemplateValue,
): { readonly prefix: string; readonly variable: string } => {
  if (typeof value === "string") return { prefix: "", variable: TOKEN_VARIABLE };
  const parts: string[] = [];
  for (const part of value) {
    if (isVariablePart(part)) {
      return { prefix: parts.join(""), variable: (part as { readonly name: string }).name };
    }
    if (typeof part === "string") parts.push(part);
  }
  return { prefix: parts.join(""), variable: TOKEN_VARIABLE };
};

export const placementsFromApiKey = (template: APIKeyAuthentication): Placement[] => {
  const placements: Placement[] = [];
  for (const [name, value] of Object.entries(template.headers ?? {})) {
    const { prefix, variable } = parseTemplateValue(value);
    placements.push({ carrier: "header", name, prefix, variable });
  }
  for (const [name, value] of Object.entries(template.queryParams ?? {})) {
    const { prefix, variable } = parseTemplateValue(value);
    placements.push({ carrier: "query", name, prefix, variable });
  }
  return placements;
};

// ---------------------------------------------------------------------------
// Templates → generic methods.
// ---------------------------------------------------------------------------

const labelForApiKey = (slug: string, placements: readonly Placement[]): string => {
  const first = placements[0];
  if (first) return `API key (${first.name || (first.carrier === "header" ? "header" : "query")})`;
  return `API key (${slug})`;
};

/** Map each stored auth template to a generic `AuthMethod`. */
export function authMethodsFromConfig(templates: readonly Authentication[]): AuthMethod[] {
  return templates.map((template: Authentication): AuthMethod => {
    const slug = String(template.slug);
    const source: "spec" | "custom" = slug.startsWith("custom_") ? "custom" : "spec";
    if (template.type === "oauth") {
      return {
        id: slug,
        label: "OAuth2",
        kind: "oauth",
        source,
        template: AuthTemplateSlug.make(slug),
        placements: [],
        // Carry the integration's declared endpoints/scopes so the
        // client-registration form pre-fills them.
        oauth: {
          authorizationUrl: template.authorizationUrl,
          tokenUrl: template.tokenUrl,
          scopes: template.scopes,
        },
      };
    }
    const placements = placementsFromApiKey(template);
    return {
      id: slug,
      label: labelForApiKey(slug, placements),
      kind: "apikey",
      source,
      template: AuthTemplateSlug.make(slug),
      placements,
    };
  });
}

// ---------------------------------------------------------------------------
// Generic placements → apiKey template (inverse).
//
// Each placement becomes a header/query slot whose value is
// `prefix ? [prefix, variable("token")] : [variable("token")]`. A custom method
// may omit `slug`; the backend backfills `custom_<id>`.
// ---------------------------------------------------------------------------

/** Slugify a placement name into a variable identifier: `DD-API-KEY` →
 *  `dd_api_key`. */
const slugifyVariable = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Assign an input variable to each (named) placement. A lone input is the
 *  canonical `token`; multiple inputs each get their own distinct variable so a
 *  connection can carry a different value per location. An explicit
 *  `placement.variable` (from a round-trip) is honored. */
const assignVariables = (placements: readonly Placement[]): Map<Placement, string> => {
  const named = placements.filter((p) => p.name);
  const out = new Map<Placement, string>();
  if (named.length <= 1) {
    for (const p of named) out.set(p, p.variable ?? TOKEN_VARIABLE);
    return out;
  }
  const taken = new Set<string>();
  for (const p of named) {
    const base = slugifyVariable(p.name) || "input";
    let candidate = p.variable ?? base;
    let n = 2;
    while (taken.has(candidate)) candidate = `${base}_${n++}`;
    taken.add(candidate);
    out.set(p, candidate);
  }
  return out;
};

const valueFromPlacement = (placement: Placement, varName: string): AuthenticationTemplateValue =>
  placement.prefix ? [placement.prefix, variable(varName)] : [variable(varName)];

/** Build an `APIKeyAuthentication` template from generic placements. When
 *  `slug` is omitted the backend assigns a `custom_<id>` slug. */
export function templateFromPlacements(
  placements: readonly Placement[],
  slug?: string,
): APIKeyAuthentication {
  const variables = assignVariables(placements);
  const headers: Record<string, AuthenticationTemplateValue> = {};
  const queryParams: Record<string, AuthenticationTemplateValue> = {};
  for (const placement of placements) {
    if (!placement.name) continue;
    const varName = variables.get(placement) ?? TOKEN_VARIABLE;
    if (placement.carrier === "header") {
      headers[placement.name] = valueFromPlacement(placement, varName);
    } else {
      queryParams[placement.name] = valueFromPlacement(placement, varName);
    }
  }
  return {
    slug: AuthTemplateSlug.make(slug ?? ""),
    type: "apiKey",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stored `Authentication` ⇆ generic `AuthTemplateEditorValue`.
//
// The shared add-time `AuthTemplateEditor` edits a plugin-agnostic value; these
// bridge it to/from the OpenAPI wire template so a spec-detected method seeds an
// editable default and the user's edits round-trip back to `Authentication[]`
// on submit. apiKey → placements; oauth → endpoints + scopes.
// ---------------------------------------------------------------------------

/** Convert one stored `Authentication` template into a generic editor value. */
export function editorValueFromAuthentication(template: Authentication): AuthTemplateEditorValue {
  if (template.type === "oauth") {
    return {
      kind: "oauth",
      authorizationUrl: template.authorizationUrl ?? "",
      tokenUrl: template.tokenUrl ?? "",
      scopes: template.scopes ?? [],
    };
  }
  return { kind: "apikey", placements: placementsFromApiKey(template) };
}

/** Build an `OAuthAuthentication` template from a generic oauth editor value. */
const oauthTemplateFromEditorValue = (
  value: Extract<AuthTemplateEditorValue, { kind: "oauth" }>,
  slug?: string,
): Authentication => ({
  slug: AuthTemplateSlug.make(slug ?? ""),
  type: "oauth",
  authorizationUrl: value.authorizationUrl,
  tokenUrl: value.tokenUrl,
  scopes: [...value.scopes],
});

/** Convert one generic editor value back into a stored `Authentication`, or
 *  `null` for `none` (no method to register). The optional `slug` names the
 *  template; when omitted the backend backfills `custom_<id>`. */
export function authenticationFromEditorValue(
  value: AuthTemplateEditorValue,
  slug?: string,
): Authentication | null {
  if (value.kind === "none") return null;
  if (value.kind === "oauth") return oauthTemplateFromEditorValue(value, slug);
  return templateFromPlacements(value.placements, slug);
}
