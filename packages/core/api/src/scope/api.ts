import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { ScopeId } from "@executor-js/sdk";

import { InternalError } from "../observability";

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ScopeInfoResponse = Schema.Struct({
  id: ScopeId,
  name: Schema.String,
  dir: Schema.String,
  stack: Schema.Array(
    Schema.Struct({
      id: ScopeId,
      name: Schema.String,
      dir: Schema.String,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ScopeApi = HttpApiGroup.make("scope").add(
  HttpApiEndpoint.get("info", "/scope", {
    success: ScopeInfoResponse,
    error: InternalError,
  }),
);
