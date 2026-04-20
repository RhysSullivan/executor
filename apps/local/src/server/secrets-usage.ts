import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { addGroup, capture, InternalError } from "@executor/api";
import { ExecutorService } from "@executor/api/server";
import { buildSecretsUsage } from "@executor/api/secrets/usage";
import { SecretsUsageApi } from "@executor/react/api/secrets-usage";
import { OpenApiExtensionService } from "@executor/plugin-openapi/api";
import { McpExtensionService } from "@executor/plugin-mcp/api";
import { GraphqlExtensionService } from "@executor/plugin-graphql/api";
import { GoogleDiscoveryExtensionService } from "@executor/plugin-google-discovery/api";
import { collectOpenApiSecretIds } from "@executor/plugin-openapi";
import { collectMcpSecretIds } from "@executor/plugin-mcp";
import { collectGraphqlSecretIds } from "@executor/plugin-graphql";
import { collectGoogleDiscoverySecretIds } from "@executor/plugin-google-discovery";

const LocalApiWithSecretsUsage = addGroup(SecretsUsageApi).addError(InternalError);

export const SecretsUsageHandlers = HttpApiBuilder.group(
  LocalApiWithSecretsUsage,
  "secretsUsage",
  (handlers) =>
  handlers.handle("list", () =>
    capture(Effect.gen(function* () {
      const executor = yield* ExecutorService;
      const openapi = yield* OpenApiExtensionService;
      const mcp = yield* McpExtensionService;
      const graphql = yield* GraphqlExtensionService;
      const googleDiscovery = yield* GoogleDiscoveryExtensionService;

      const sources = (yield* executor.sources.list().pipe(
        Effect.catchAll(() => Effect.succeed([])),
      ));

      return yield* buildSecretsUsage(sources, {
        openapi: (sourceId, scopeId) =>
          openapi
            .getSource(sourceId, scopeId)
            .pipe(Effect.map((stored) => (stored ? collectOpenApiSecretIds(stored) : []))),
        mcp: (sourceId, scopeId) =>
          mcp
            .getSource(sourceId, scopeId)
            .pipe(Effect.map((stored) => (stored ? collectMcpSecretIds(stored) : []))),
        graphql: (sourceId, scopeId) =>
          graphql
            .getSource(sourceId, scopeId)
            .pipe(Effect.map((stored) => (stored ? collectGraphqlSecretIds(stored) : []))),
        googleDiscovery: (sourceId, scopeId) =>
          googleDiscovery
            .getSource(sourceId, scopeId)
            .pipe(
              Effect.map((stored) => (stored ? collectGoogleDiscoverySecretIds(stored) : [])),
            ),
      });
    })),
  ),
);
