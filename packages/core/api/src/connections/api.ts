import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

import {
  ConnectionId,
  ScopeId,
  SecretId,
} from "@executor/sdk";

import { InternalError } from "../observability";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const connectionIdParam = HttpApiSchema.param("connectionId", ConnectionId);

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ConnectionRefResponse = Schema.Struct({
  id: ConnectionId,
  scopeId: ScopeId,
  provider: Schema.String,
  identityLabel: Schema.NullOr(Schema.String),
  accessTokenSecretId: SecretId,
  refreshTokenSecretId: Schema.NullOr(SecretId),
  expiresAt: Schema.NullOr(Schema.Number),
  oauthScope: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class ConnectionsApi extends HttpApiGroup.make("connections")
  .add(
    HttpApiEndpoint.get(
      "list",
    )`/scopes/${scopeIdParam}/connections`.addSuccess(
      Schema.Array(ConnectionRefResponse),
    ),
  )
  .add(
    HttpApiEndpoint.del(
      "remove",
    )`/scopes/${scopeIdParam}/connections/${connectionIdParam}`.addSuccess(
      Schema.Struct({ removed: Schema.Boolean }),
    ),
  )
  .addError(InternalError) {}
