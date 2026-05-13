import { Schema } from "effect";

import { ScopeId, SecretId, ConnectionId } from "./ids";

// ---------------------------------------------------------------------------
// Usage — one row per place a secret or connection is referenced. Each
// plugin contributes its own usages via `usagesForSecret` /
// `usagesForConnection`; the executor fans out and concatenates.
//
// `pluginId` identifies the plugin that owns the reference. `ownerKind`
// is plugin-defined (e.g. "openapi-source-oauth2", "mcp-source-auth",
// "graphql-source-header"); the UI groups by it for a "used in N
// sources / M bindings" summary. `slot` describes which field within
// the owner holds the ref ("oauth2.client_secret", "header:Authorization",
// "binding:value") so the user can locate it.
//
// `ownerName` is resolved by JOIN at query time from the parent source /
// binding row. It's nullable because a plugin may have an owner that has
// no human-readable name (e.g. an unnamed binding row).
//
// `scopeId` is the scope the owner row lives in — plugins query through
// their scoped adapter (which auto-filters by `scope_id IN (stack)`), so
// usages from outer scopes naturally surface alongside inner ones; the
// UI uses the scope to render a per-scope label next to each entry.
// ---------------------------------------------------------------------------

export const Usage = Schema.Struct({
  pluginId: Schema.String,
  scopeId: ScopeId,
  ownerKind: Schema.String,
  ownerId: Schema.String,
  ownerName: Schema.NullOr(Schema.String),
  slot: Schema.String,
});
export type Usage = typeof Usage.Type;

export interface UsagesForSecretInput {
  readonly secretId: SecretId;
}

export interface UsagesForConnectionInput {
  readonly connectionId: ConnectionId;
}
