import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";

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
// Errors with HTTP status
// ---------------------------------------------------------------------------

const OpError = OnePasswordError.annotations(
  HttpApiSchema.annotations({ status: 502 }),
);

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class OnePasswordGroup extends HttpApiGroup.make("onepassword")
  .add(
    HttpApiEndpoint.get("getConfig")`/scopes/${scopeIdParam}/onepassword/config`
      .addSuccess(GetConfigResponse),
  )
  .add(
    HttpApiEndpoint.put("configure")`/scopes/${scopeIdParam}/onepassword/config`
      .setPayload(ConfigurePayload)
      .addSuccess(Schema.Void)
      .addError(OpError),
  )
  .add(
    HttpApiEndpoint.del("removeConfig")`/scopes/${scopeIdParam}/onepassword/config`
      .addSuccess(Schema.Void),
  )
  .add(
    HttpApiEndpoint.get("status")`/scopes/${scopeIdParam}/onepassword/status`
      .addSuccess(ConnectionStatus)
      .addError(OpError),
  )
  .add(
    HttpApiEndpoint.get("listVaults")`/scopes/${scopeIdParam}/onepassword/vaults`
      .setUrlParams(ListVaultsParams)
      .addSuccess(ListVaultsResponse)
      .addError(OpError),
  )
  {}
