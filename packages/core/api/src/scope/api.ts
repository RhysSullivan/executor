import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";

import { InternalError } from "../observability";

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ScopeChainEntry = Schema.Struct({
  id: ScopeId,
  name: Schema.String,
});

// `id` / `name` / `dir` describe the request's write-target scope —
// kept as loose top-level fields for existing callers that just want
// "the active scope". `chain` is the full read chain innermost-first;
// single-element for CLI/local hosts, `[user, org]` (or longer in the
// future) for cloud hosts so the UI can offer a scope selector and
// render a scope badge on layered rows.
const ScopeInfoResponse = Schema.Struct({
  id: ScopeId,
  name: Schema.String,
  dir: Schema.String,
  chain: Schema.Array(ScopeChainEntry),
});

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class ScopeApi extends HttpApiGroup.make("scope")
  .add(HttpApiEndpoint.get("info")`/scope`.addSuccess(ScopeInfoResponse))
  .addError(InternalError) {}
