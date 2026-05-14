import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  CredentialBindingRef,
  RemoveCredentialBindingInput,
  ScopeId,
  SetCredentialBindingInput,
} from "@executor-js/sdk";

import { InternalError } from "../observability";

const ScopeParams = { scopeId: ScopeId };
const CredentialBindingSourceParams = {
  scopeId: ScopeId,
  pluginId: Schema.String,
  sourceId: Schema.String,
  sourceScope: ScopeId,
};

export const CredentialBindingsApi = HttpApiGroup.make("credentialBindings")
  .add(
    HttpApiEndpoint.get(
      "listForSource",
      "/scopes/:scopeId/credential-bindings/:pluginId/sources/:sourceId/base/:sourceScope",
      {
        params: CredentialBindingSourceParams,
        success: Schema.Array(CredentialBindingRef),
        error: InternalError,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("set", "/scopes/:scopeId/credential-bindings", {
      params: ScopeParams,
      payload: SetCredentialBindingInput,
      success: CredentialBindingRef,
      error: InternalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("remove", "/scopes/:scopeId/credential-bindings/remove", {
      params: ScopeParams,
      payload: RemoveCredentialBindingInput,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: InternalError,
    }),
  );
