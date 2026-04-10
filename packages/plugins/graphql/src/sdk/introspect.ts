import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";

import { GraphqlIntrospectionError } from "./errors";

// ---------------------------------------------------------------------------
// Introspection query — standard GraphQL introspection
// ---------------------------------------------------------------------------

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        description
        fields(includeDeprecated: false) {
          name
          description
          args {
            name
            description
            type {
              ...TypeRef
            }
            defaultValue
          }
          type {
            ...TypeRef
          }
        }
        inputFields {
          name
          description
          type {
            ...TypeRef
          }
          defaultValue
        }
        enumValues(includeDeprecated: false) {
          name
          description
        }
      }
    }
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Introspection result types
// ---------------------------------------------------------------------------

export interface IntrospectionTypeRef {
  readonly kind: string;
  readonly name: string | null;
  readonly ofType: IntrospectionTypeRef | null;
}

export interface IntrospectionInputValue {
  readonly name: string;
  readonly description: string | null;
  readonly type: IntrospectionTypeRef;
  readonly defaultValue: string | null;
}

export interface IntrospectionField {
  readonly name: string;
  readonly description: string | null;
  readonly args: readonly IntrospectionInputValue[];
  readonly type: IntrospectionTypeRef;
}

export interface IntrospectionEnumValue {
  readonly name: string;
  readonly description: string | null;
}

export interface IntrospectionType {
  readonly kind: string;
  readonly name: string;
  readonly description: string | null;
  readonly fields: readonly IntrospectionField[] | null;
  readonly inputFields: readonly IntrospectionInputValue[] | null;
  readonly enumValues: readonly IntrospectionEnumValue[] | null;
}

export interface IntrospectionSchema {
  readonly queryType: { readonly name: string } | null;
  readonly mutationType: { readonly name: string } | null;
  readonly types: readonly IntrospectionType[];
}

export interface IntrospectionResult {
  readonly __schema: IntrospectionSchema;
}

// ---------------------------------------------------------------------------
// Introspect a GraphQL endpoint
// ---------------------------------------------------------------------------

export const introspect = Effect.fn("GraphQL.introspect")(function* (
  endpoint: string,
  headers?: Record<string, string>,
) {
  const client = yield* HttpClient.HttpClient;

  let request = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.setHeader("Content-Type", "application/json"),
    HttpClientRequest.bodyUnsafeJson({
      query: INTROSPECTION_QUERY,
    }),
  );

  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      request = HttpClientRequest.setHeader(request, k, v);
    }
  }

  const response = yield* client.execute(request).pipe(
    Effect.tapErrorCause((cause) => Effect.logError("graphql introspection request failed", cause)),
    Effect.mapError(
      (err) =>
        new GraphqlIntrospectionError({
          message: `Failed to reach GraphQL endpoint: ${err.message}`,
        }),
    ),
  );

  if (response.status !== 200) {
    return yield* new GraphqlIntrospectionError({
      message: `Introspection failed with status ${response.status}`,
    });
  }

  const raw = yield* response.json.pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError("graphql introspection JSON parse failed", cause),
    ),
    Effect.mapError(
      () =>
        new GraphqlIntrospectionError({
          message: `Failed to parse introspection response as JSON`,
        }),
    ),
  );

  const json = raw as { data?: IntrospectionResult; errors?: unknown[] };

  if (json.errors && Array.isArray(json.errors) && json.errors.length > 0) {
    return yield* new GraphqlIntrospectionError({
      message: `Introspection returned ${json.errors.length} error(s)`,
    });
  }

  if (!json.data?.__schema) {
    return yield* new GraphqlIntrospectionError({
      message: "Introspection response missing __schema",
    });
  }

  return json.data;
});

// ---------------------------------------------------------------------------
// Parse an introspection result from a JSON string (for offline/text input)
// ---------------------------------------------------------------------------

export const parseIntrospectionJson = (
  text: string,
): Effect.Effect<IntrospectionResult, GraphqlIntrospectionError> =>
  Effect.try({
    try: () => {
      const parsed = JSON.parse(text);
      // Accept both { data: { __schema } } and { __schema } formats
      const result = parsed.data ?? parsed;
      if (!result.__schema) {
        throw new Error("Missing __schema in introspection JSON");
      }
      return result as IntrospectionResult;
    },
    catch: (err) =>
      new GraphqlIntrospectionError({
        message: `Failed to parse introspection JSON: ${err instanceof Error ? err.message : String(err)}`,
      }),
  });
