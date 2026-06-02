import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError, ScopeId } from "@executor-js/sdk/shared";

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
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "scope.info",
      summary: "Scope Info",
      description:
        "Returns the current scope's id, name, directory, and its full parent scope stack.",
    }),
  ),
);
