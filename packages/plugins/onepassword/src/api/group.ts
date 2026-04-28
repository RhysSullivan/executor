import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";
import { InternalError } from "@executor/api";

import { OnePasswordError } from "../sdk/errors";
import { OnePasswordConfig, Vault, ConnectionStatus } from "../sdk/types";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const ConfigurePayload = OnePasswordConfig;

const ListVaultsParams = Schema.Struct({
  authKind: Schema.Literal("desktop-app", "service-account"),
  account: Schema.String,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const ListVaultsResponse = Schema.Struct({
  vaults: Schema.Array(Vault),
});

const GetConfigResponse = Schema.NullOr(OnePasswordConfig);

// ---------------------------------------------------------------------------
// Group
//
// Plugin SDK errors (OnePasswordError) are declared once at the group level
// via `.addError(...)` — every endpoint inherits. The error carries its own
// 502 status via `HttpApiSchema.annotations` in errors.ts.
//
// `InternalError` is the shared opaque 500 schema translated at the HTTP
// edge by `withCapture` (see observability.ts). Storage failures on
// `ctx.storage`/`ctx.secrets` flow through as `StorageFailure` in the
// typed channel and are captured + downgraded to `InternalError({ traceId })`
// at Layer composition. No per-handler translation.
// ---------------------------------------------------------------------------

export class OnePasswordGroup extends HttpApiGroup.make("onepassword")
  .add(
    HttpApiEndpoint.get("getConfig")`/scopes/${scopeIdParam}/onepassword/config`.addSuccess(
      GetConfigResponse,
    ),
  )
  .add(
    HttpApiEndpoint.put("configure")`/scopes/${scopeIdParam}/onepassword/config`
      .setPayload(ConfigurePayload)
      .addSuccess(Schema.Void),
  )
  .add(
    HttpApiEndpoint.del("removeConfig")`/scopes/${scopeIdParam}/onepassword/config`.addSuccess(
      Schema.Void,
    ),
  )
  .add(
    HttpApiEndpoint.get("status")`/scopes/${scopeIdParam}/onepassword/status`.addSuccess(
      ConnectionStatus,
    ),
  )
  .add(
    HttpApiEndpoint.get("listVaults")`/scopes/${scopeIdParam}/onepassword/vaults`
      .setUrlParams(ListVaultsParams)
      .addSuccess(ListVaultsResponse),
  )
  .addError(InternalError)
  .addError(OnePasswordError) {}
