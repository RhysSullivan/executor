import {
  executeHttpProbe,
  namespaceFromSourceName,
  noneAuthInference,
  supportedAuthInference,
  trimOrNull,
  type SourceAuthInference,
  type SourceDiscoveryProbeInput,
  type SourceDiscoveryResult,
} from "@executor/source-core";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";

import { extractGoogleDiscoveryManifest } from "./document";

const googleDiscoveryEndpoint = (input: {
  rootUrl: string;
  servicePath: string;
}): string => {
  try {
    return new URL(input.servicePath || "", input.rootUrl).toString();
  } catch {
    return input.rootUrl;
  }
};

const inferGoogleDiscoveryAuth = (input: {
  scopes: ReadonlyArray<string>;
}): SourceAuthInference =>
  input.scopes.length > 0
    ? supportedAuthInference("oauth2", {
        confidence: "high",
        reason: "Google Discovery document declares OAuth scopes",
        headerName: "Authorization",
        prefix: "Bearer ",
        parameterName: null,
        parameterLocation: null,
        oauthAuthorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        oauthTokenUrl: "https://oauth2.googleapis.com/token",
        oauthScopes: [...input.scopes],
      })
    : noneAuthInference(
        "Google Discovery document does not declare OAuth scopes",
        "medium",
      );

export const detectGoogleDiscoverySource = (
  input: SourceDiscoveryProbeInput,
): Effect.Effect<SourceDiscoveryResult | null, never, never> =>
  Effect.gen(function* () {
    const response = yield* Effect.either(executeHttpProbe({
      method: "GET",
      url: input.normalizedUrl,
      headers: input.headers,
    }));

    if (Either.isLeft(response)) {
      return null;
    }

    if (response.right.status < 200 || response.right.status >= 300) {
      return null;
    }

    const manifest = yield* Effect.either(
      extractGoogleDiscoveryManifest(input.normalizedUrl, response.right.text),
    );
    if (Either.isLeft(manifest)) {
      return null;
    }

    const endpoint = googleDiscoveryEndpoint({
      rootUrl: manifest.right.rootUrl,
      servicePath: manifest.right.servicePath,
    });
    const name = trimOrNull(manifest.right.title)
      ?? `${manifest.right.service}.${manifest.right.versionName}.googleapis.com`;
    const oauthScopes = Object.keys(manifest.right.oauthScopes ?? {});

    return {
      detectedKind: "plugin",
      confidence: "high",
      endpoint,
      specUrl: input.normalizedUrl,
      name,
      namespace: namespaceFromSourceName(manifest.right.service),
      transport: null,
      authInference: inferGoogleDiscoveryAuth({
        scopes: oauthScopes,
      }),
      toolCount: manifest.right.methods.length,
      warnings: [],
    } satisfies SourceDiscoveryResult;
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
