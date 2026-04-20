import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);

export const SecretUsage = Schema.Struct({
  sourceId: Schema.String,
  sourceName: Schema.String,
  sourceKind: Schema.String,
});

export const SecretUsageEntry = Schema.Struct({
  secretId: Schema.String,
  usedBy: Schema.Array(SecretUsage),
});

export class SecretsUsageApi extends HttpApiGroup.make("secretsUsage").add(
  HttpApiEndpoint.get("list")`/scopes/${scopeIdParam}/secrets/usage`.addSuccess(
    Schema.Array(SecretUsageEntry),
  ),
) {}

export type SecretUsage = typeof SecretUsage.Type;
export type SecretUsageEntry = typeof SecretUsageEntry.Type;
