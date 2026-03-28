import {
  defaultNameFromEndpoint,
  namespaceFromSourceName,
  noneAuthInference,
  supportedAuthInference,
  type SourceDiscoveryProbeInput,
  type SourceDiscoveryResult,
} from "@executor/source-core";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";

import { createSdkMcpConnector } from "./connection";
import { startMcpOAuthAuthorization } from "./oauth";
import { discoverMcpToolsFromConnector } from "./tools";

export const detectMcpSource = (
  input: SourceDiscoveryProbeInput,
): Effect.Effect<SourceDiscoveryResult | null, never, never> =>
  Effect.gen(function* () {
    const connector = createSdkMcpConnector({
      endpoint: input.normalizedUrl,
      headers: input.headers,
      transport: "auto",
    });

    const discovered = yield* Effect.either(discoverMcpToolsFromConnector({
      connect: connector,
      sourceKey: "discovery",
      namespace: namespaceFromSourceName(defaultNameFromEndpoint(input.normalizedUrl)),
    }));

    if (Either.isRight(discovered)) {
      const name = defaultNameFromEndpoint(input.normalizedUrl);
      return {
        detectedKind: "plugin",
        confidence: "high",
        endpoint: input.normalizedUrl,
        specUrl: null,
        name,
        namespace: namespaceFromSourceName(name),
        transport: "auto",
        authInference: noneAuthInference(
          "MCP tool discovery succeeded without an advertised auth requirement",
          "medium",
        ),
        toolCount: discovered.right.manifest.tools.length,
        warnings: [],
      } satisfies SourceDiscoveryResult;
    }

    const oauthProbe = yield* Effect.either(startMcpOAuthAuthorization({
      endpoint: input.normalizedUrl,
      redirectUrl: "http://127.0.0.1/executor/discovery/oauth/callback",
      state: "source-discovery",
    }));

    if (Either.isLeft(oauthProbe)) {
      return null;
    }

    const name = defaultNameFromEndpoint(input.normalizedUrl);
    return {
      detectedKind: "plugin",
      confidence: "high",
      endpoint: input.normalizedUrl,
      specUrl: null,
      name,
      namespace: namespaceFromSourceName(name),
      transport: "auto",
      authInference: supportedAuthInference("oauth2", {
        confidence: "high",
        reason: "MCP endpoint advertised OAuth during discovery",
        headerName: "Authorization",
        prefix: "Bearer ",
        parameterName: null,
        parameterLocation: null,
        oauthAuthorizationUrl: oauthProbe.right.authorizationUrl,
        oauthTokenUrl: oauthProbe.right.authorizationServerUrl,
        oauthScopes: [],
      }),
      toolCount: null,
      warnings: ["OAuth is required before MCP tools can be listed."],
    } satisfies SourceDiscoveryResult;
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
