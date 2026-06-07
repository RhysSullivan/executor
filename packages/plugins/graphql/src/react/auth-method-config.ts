// ---------------------------------------------------------------------------
// GraphQL ↔ generic auth-method converters.
//
// The generic Accounts hub + add-time auth editor speak in plugin-agnostic
// `AuthMethod` / `Placement` values (`@executor-js/react/lib/auth-placements`).
// The GraphQL plugin stores auth as its own `AuthTemplate` wire shape
// (`{ kind:"apiKey", slug, in, name, prefix? }` / `{ kind:"oauth2", slug, … }`).
// These converters bridge that wire shape to/from the generic placement model,
// so they live with the GraphQL plugin — they touch the graphql sdk
// `AuthTemplate` types and would pull transport specifics into core.
// ---------------------------------------------------------------------------

import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";

import { GRAPHQL_APIKEY_TEMPLATE } from "./defaults";
import type { AuthTemplate } from "../sdk/types";

// ---------------------------------------------------------------------------
// Templates → generic methods.
// ---------------------------------------------------------------------------

const labelForApiKey = (slug: string, name: string): string => `API key (${name || slug})`;

/** Map each stored GraphQL auth template to a generic `AuthMethod`. A `custom_`
 *  slug marks a user-defined method; everything else is spec-declared. */
export function authMethodsFromConfig(templates: readonly AuthTemplate[]): AuthMethod[] {
  return templates.map((template: AuthTemplate): AuthMethod => {
    const slug = String(template.slug);
    const source: "spec" | "custom" = slug.startsWith("custom_") ? "custom" : "spec";
    if (template.kind === "oauth2") {
      return {
        id: slug,
        label: "OAuth2",
        kind: "oauth",
        source,
        template: AuthTemplateSlug.make(slug),
        placements: [],
        oauth: {},
      };
    }
    const placement: Placement = {
      carrier: template.in,
      name: template.name,
      prefix: template.prefix ?? "",
    };
    return {
      id: slug,
      label: labelForApiKey(slug, template.name),
      kind: "apikey",
      source,
      template: AuthTemplateSlug.make(slug),
      placements: [placement],
    };
  });
}

// ---------------------------------------------------------------------------
// Generic placements → graphql apiKey templates (inverse).
//
// GraphQL's `AuthTemplate` carries ONE header/query slot per template, so a
// multi-placement method emits one template per named placement. When `slug` is
// omitted the backend backfills `custom_<id>`; the first template keeps the
// integration's primary `apiKey` slug so the add flow stays stable.
// ---------------------------------------------------------------------------

/** Build GraphQL `apiKey` templates from generic placements. The optional
 *  `slug` names the FIRST emitted template (subsequent placements get an empty
 *  slug so the backend assigns a `custom_<id>` each). */
export function graphqlTemplatesFromPlacements(
  placements: readonly Placement[],
  slug?: string,
): AuthTemplate[] {
  const named = placements.filter((placement: Placement) => placement.name.trim().length > 0);
  return named.map(
    (placement: Placement, index: number): AuthTemplate => ({
      kind: "apiKey",
      slug: index === 0 ? (slug ?? GRAPHQL_APIKEY_TEMPLATE) : "",
      in: placement.carrier,
      name: placement.name,
      ...(placement.prefix ? { prefix: placement.prefix } : {}),
    }),
  );
}
