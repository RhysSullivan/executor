import type { Owner } from "@executor-js/sdk/shared";
import { ConnectionName } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// v2 connection-create defaults for the GraphQL plugin. v1's HTTP-credentials
// editor (header/query secret slots bound per source per scope) is gone: a
// connection IS the credential, applied to the integration's auth template.
// ---------------------------------------------------------------------------

/** The slug of the apiKey auth template the add flow declares + targets. */
export const GRAPHQL_APIKEY_TEMPLATE = "apiKey";

/** Build the apiKey auth template the integration stores. The connection's
 *  value is written to `headerName` at invoke time (no prefix — the user pastes
 *  the full header value, e.g. `Bearer ghp_…`). */
export const graphqlApiKeyAuthTemplate = (
  headerName: string,
): {
  readonly kind: "apiKey";
  readonly slug: string;
  readonly in: "header";
  readonly name: string;
} => ({
  kind: "apiKey",
  slug: GRAPHQL_APIKEY_TEMPLATE,
  in: "header",
  name: headerName || "Authorization",
});

/** Deterministic connection name for a GraphQL integration + owner. Keeps a
 *  single owner-scoped credential per integration so re-adding overwrites
 *  rather than accumulating duplicates. */
export const graphqlConnectionName = (slug: string, owner: Owner): ConnectionName =>
  ConnectionName.make(`${slug}-${owner}`);
