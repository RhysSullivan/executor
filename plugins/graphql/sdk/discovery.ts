import {
  defaultNameFromEndpoint,
  executeHttpProbe,
  isRecord,
  namespaceFromSourceName,
  noneAuthInference,
  parseChallengeAuthInference,
  tryParseJson,
  type SourceDiscoveryProbeInput,
  type SourceDiscoveryResult,
} from "@executor/source-core";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";

import { GRAPHQL_INTROSPECTION_QUERY } from "./graphql-tools";

const looksLikeGraphqlEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    return /graphql/i.test(`${url.hostname}${url.pathname}`);
  } catch {
    return /graphql/i.test(value);
  }
};

export const detectGraphqlSource = (
  input: SourceDiscoveryProbeInput,
): Effect.Effect<SourceDiscoveryResult | null, never, never> =>
  Effect.gen(function* () {
    const response = yield* Effect.either(executeHttpProbe({
      method: "POST",
      url: input.normalizedUrl,
      headers: {
        accept: "application/graphql-response+json, application/json",
        "content-type": "application/json",
        ...input.headers,
      },
      body: JSON.stringify({ query: GRAPHQL_INTROSPECTION_QUERY }),
    }));

    if (Either.isLeft(response)) {
      return null;
    }

    const parsed = tryParseJson(response.right.text);
    const contentType = (response.right.headers["content-type"] ?? "").toLowerCase();
    const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : null;
    if (data && isRecord(data.__schema)) {
      const name = defaultNameFromEndpoint(input.normalizedUrl);
      return {
        detectedKind: "plugin",
        confidence: "high",
        endpoint: input.normalizedUrl,
        specUrl: null,
        name,
        namespace: namespaceFromSourceName(name),
        transport: null,
        authInference: noneAuthInference(
          "GraphQL introspection succeeded without an advertised auth requirement",
          "medium",
        ),
        toolCount: null,
        warnings: [],
      } satisfies SourceDiscoveryResult;
    }

    const errors = isRecord(parsed) && Array.isArray(parsed.errors)
      ? parsed.errors
      : [];
    const graphqlErrors = errors
      .map((error) => isRecord(error) ? (typeof error.message === "string" ? error.message : null) : null)
      .filter((message): message is string => message !== null);

    const mediumConfidenceGraphql =
      contentType.includes("application/graphql-response+json")
      || (looksLikeGraphqlEndpoint(input.normalizedUrl) && response.right.status >= 400 && response.right.status < 500)
      || graphqlErrors.some((message) => /introspection|graphql|query/i.test(message));

    if (!mediumConfidenceGraphql) {
      return null;
    }

    const name = defaultNameFromEndpoint(input.normalizedUrl);
    return {
      detectedKind: "plugin",
      confidence: data ? "high" : "medium",
      endpoint: input.normalizedUrl,
      specUrl: null,
      name,
      namespace: namespaceFromSourceName(name),
      transport: null,
      authInference:
        response.right.status === 401 || response.right.status === 403
          ? parseChallengeAuthInference(
              response.right.headers,
              "GraphQL endpoint rejected introspection and did not advertise a concrete auth scheme",
            )
          : noneAuthInference(
              graphqlErrors.length > 0
                ? `GraphQL endpoint responded with errors during introspection: ${graphqlErrors[0]}`
                : "GraphQL endpoint shape detected",
              "medium",
            ),
      toolCount: null,
      warnings: graphqlErrors.length > 0 ? [graphqlErrors[0]!] : [],
    } satisfies SourceDiscoveryResult;
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
