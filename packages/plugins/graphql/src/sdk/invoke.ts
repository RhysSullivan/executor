import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";

import { GraphqlInvocationError } from "./errors";
import {
  type HeaderValue,
  type OperationBinding,
  InvocationResult,
} from "./types";

// ---------------------------------------------------------------------------
// Header resolution — resolves secret refs at invocation time
// ---------------------------------------------------------------------------

export const resolveHeaders = (
  headers: Record<string, HeaderValue>,
  secrets: { readonly get: (id: string) => Effect.Effect<string | null, Error> },
): Effect.Effect<Record<string, string>, Error> =>
  Effect.gen(function* () {
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string") {
        resolved[name] = value;
      } else {
        const secret = yield* secrets.get(value.secretId).pipe(
          Effect.catchAll(() => Effect.succeed<string | null>(null)),
        );
        if (secret !== null) {
          resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
        }
      }
    }
    return resolved;
  });

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const isJsonContentType = (ct: string | null | undefined): boolean => {
  if (!ct) return false;
  const normalized = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized === "application/json" || normalized.includes("+json") || normalized.includes("json")
  );
};

// ---------------------------------------------------------------------------
// Public API — execute a GraphQL operation
// ---------------------------------------------------------------------------

export const invoke = Effect.fn("GraphQL.invoke")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  endpoint: string,
  resolvedHeaders: Record<string, string>,
) {
  const client = yield* HttpClient.HttpClient;

  // Build the GraphQL request body
  const variables: Record<string, unknown> = {};
  for (const varName of operation.variableNames) {
    if (args[varName] !== undefined) {
      variables[varName] = args[varName];
    }
  }

  // Also pick up any variables from a "variables" container
  if (typeof args.variables === "object" && args.variables !== null) {
    Object.assign(variables, args.variables);
  }

  let request = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.setHeader("Content-Type", "application/json"),
    HttpClientRequest.bodyUnsafeJson({
      query: operation.operationString,
      variables: Object.keys(variables).length > 0 ? variables : undefined,
    }),
  );

  for (const [name, value] of Object.entries(resolvedHeaders)) {
    request = HttpClientRequest.setHeader(request, name, value);
  }

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new GraphqlInvocationError({
          message: `GraphQL request failed: ${err.message}`,
          statusCode: Option.none(),
          cause: err,
        }),
    ),
  );

  const status = response.status;
  const contentType = response.headers["content-type"] ?? null;

  const body: unknown = isJsonContentType(contentType)
    ? yield* response.json.pipe(Effect.catchAll(() => response.text))
    : yield* response.text;

  // GraphQL responses are always 200 with { data, errors }
  const gqlBody = body as { data?: unknown; errors?: unknown[] } | null;
  const hasErrors = Array.isArray(gqlBody?.errors) && gqlBody.errors.length > 0;

  return new InvocationResult({
    status,
    data: gqlBody?.data ?? null,
    errors: hasErrors ? gqlBody!.errors : null,
  });
});

// ---------------------------------------------------------------------------
// Invoke a GraphQL operation with a provided HttpClient layer
// ---------------------------------------------------------------------------

export const invokeWithLayer = (
  operation: OperationBinding,
  args: Record<string, unknown>,
  endpoint: string,
  resolvedHeaders: Record<string, string>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
): Effect.Effect<InvocationResult, Error> =>
  invoke(operation, args, endpoint, resolvedHeaders).pipe(
    Effect.provide(httpClientLayer),
    Effect.mapError((err) =>
      err instanceof Error
        ? err
        : new GraphqlInvocationError({
            message: String(err),
            statusCode: Option.none(),
            cause: err,
          }),
    ),
  );
