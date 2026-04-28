import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";

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

export class ScopeApi extends HttpApiGroup.make("scope")
  .add(HttpApiEndpoint.get("info")`/scope`.addSuccess(ScopeInfoResponse))
  .addError(InternalError) {}
