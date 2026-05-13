import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";

import { ConnectionId, ConnectionInUseError, ScopeId, Usage } from "@executor-js/sdk";

import { InternalError } from "../observability";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ScopeParams = { scopeId: ScopeId };
const ConnectionParams = { scopeId: ScopeId, connectionId: ConnectionId };

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ConnectionRefResponse = Schema.Struct({
  id: ConnectionId,
  scopeId: ScopeId,
  provider: Schema.String,
  identityLabel: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number),
  oauthScope: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

const ConnectionInUse = ConnectionInUseError.annotate({ httpApiStatus: 409 });

export const ConnectionsApi = HttpApiGroup.make("connections")
  .add(
    HttpApiEndpoint.get("list", "/scopes/:scopeId/connections", {
      params: ScopeParams,
      success: Schema.Array(ConnectionRefResponse),
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/scopes/:scopeId/connections/:connectionId", {
      params: ConnectionParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [InternalError, ConnectionInUse],
    }),
  )
  .add(
    HttpApiEndpoint.get("usages", "/scopes/:scopeId/connections/:connectionId/usages", {
      params: ConnectionParams,
      success: Schema.Array(Usage),
      error: InternalError,
    }),
  );
