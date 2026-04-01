import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import {
  ScopeId,
  SecretId,
  SecretNotFoundError,
  SecretResolutionError,
} from "@executor/sdk";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const secretIdParam = HttpApiSchema.param("secretId", SecretId);

// ---------------------------------------------------------------------------
// Response / payload schemas
// ---------------------------------------------------------------------------

const SecretRefResponse = Schema.Struct({
  id: SecretId,
  scopeId: ScopeId,
  name: Schema.String,
  provider: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
  createdAt: Schema.Number,
});

const SecretStatusResponse = Schema.Struct({
  secretId: SecretId,
  status: Schema.Literal("resolved", "missing"),
});

const SetSecretPayload = Schema.Struct({
  id: SecretId,
  name: Schema.String,
  value: Schema.String,
  purpose: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Error schemas with HTTP status annotations
// ---------------------------------------------------------------------------

const SecretNotFound = SecretNotFoundError.annotations(
  HttpApiSchema.annotations({ status: 404 }),
);
const SecretResolution = SecretResolutionError.annotations(
  HttpApiSchema.annotations({ status: 500 }),
);

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export class SecretsApi extends HttpApiGroup.make("secrets")
  .add(
    HttpApiEndpoint.get("list")`/scopes/${scopeIdParam}/secrets`
      .addSuccess(Schema.Array(SecretRefResponse)),
  )
  .add(
    HttpApiEndpoint.get("status")`/scopes/${scopeIdParam}/secrets/${secretIdParam}/status`
      .addSuccess(SecretStatusResponse),
  )
  .add(
    HttpApiEndpoint.post("set")`/scopes/${scopeIdParam}/secrets`
      .setPayload(SetSecretPayload)
      .addSuccess(SecretRefResponse)
      .addError(SecretResolution),
  )
  .add(
    HttpApiEndpoint.del("remove")`/scopes/${scopeIdParam}/secrets/${secretIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(SecretNotFound),
  )
  .prefix("/v1") {}
