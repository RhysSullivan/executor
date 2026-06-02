import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError, ScopeId } from "@executor-js/sdk/shared";

import { OnePasswordError } from "../sdk/errors";
import { OnePasswordConfig, Vault, ConnectionStatus } from "../sdk/types";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const ScopeParams = { scopeId: ScopeId };

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const ConfigurePayload = OnePasswordConfig;

const ListVaultsParams = Schema.Struct({
  authKind: Schema.Literals(["desktop-app", "service-account"]),
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

export const OnePasswordGroup = HttpApiGroup.make("onepassword")
  .add(
    HttpApiEndpoint.get("getConfig", "/scopes/:scopeId/onepassword/config", {
      params: ScopeParams,
      success: GetConfigResponse,
      error: [InternalError, OnePasswordError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "onepassword.getConfig",
        summary: "Get Config",
        description:
          "Returns the 1Password configuration for the given scope, or null if none is configured.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("configure", "/scopes/:scopeId/onepassword/config", {
      params: ScopeParams,
      payload: ConfigurePayload,
      success: Schema.Void,
      error: [InternalError, OnePasswordError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "onepassword.configure",
        summary: "Configure 1Password",
        description: "Sets the 1Password configuration for the given scope.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("removeConfig", "/scopes/:scopeId/onepassword/config", {
      params: ScopeParams,
      success: Schema.Void,
      error: [InternalError, OnePasswordError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "onepassword.removeConfig",
        summary: "Remove Config",
        description: "Deletes the 1Password configuration for the given scope.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("status", "/scopes/:scopeId/onepassword/status", {
      params: ScopeParams,
      success: ConnectionStatus,
      error: [InternalError, OnePasswordError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "onepassword.status",
        summary: "Connection Status",
        description: "Reports the current 1Password connection status for the given scope.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("listVaults", "/scopes/:scopeId/onepassword/vaults", {
      params: ScopeParams,
      query: ListVaultsParams,
      success: ListVaultsResponse,
      error: [InternalError, OnePasswordError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "onepassword.listVaults",
        summary: "List Vaults",
        description:
          "Lists the 1Password vaults available for the given scope and authentication method.",
      }),
    ),
  );
