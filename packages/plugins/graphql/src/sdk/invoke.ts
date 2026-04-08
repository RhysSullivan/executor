import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";

import {
  type ToolId,
  type ToolInvoker,
  ToolInvocationResult,
  ToolInvocationError,
  type ScopeId,
  type SecretId,
} from "@executor/core";

import { GraphqlInvocationError } from "./errors";
import type { GraphqlOperationStore } from "./operation-store";
import {
  type HeaderValue,
  type OperationBinding,
  InvocationConfig,
  InvocationResult,
} from "./types";

// ---------------------------------------------------------------------------
// Header resolution — resolves secret refs at invocation time
// ---------------------------------------------------------------------------

const resolveHeaders = (
  headers: Record<string, HeaderValue>,
  secrets: { readonly resolve: (secretId: SecretId, scopeId: ScopeId) => Effect.Effect<string, unknown> },
  scopeId: ScopeId,
): Effect.Effect<Record<string, string>, ToolInvocationError> =>
  Effect.gen(function* () {
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string") {
        resolved[name] = value;
      } else {
        const secret = yield* secrets.resolve(value.secretId as SecretId, scopeId).pipe(
          Effect.mapError(() =>
            new ToolInvocationError({
              toolId: "" as ToolId,
              message: `Failed to resolve secret "${value.secretId}" for header "${name}"`,
              cause: undefined,
            }),
          ),
        );
        resolved[name] = value.prefix ? `${value.prefix}${secret}` : secret;
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
    normalized === "application/json" ||
    normalized.includes("+json") ||
    normalized.includes("json")
  );
};

// ---------------------------------------------------------------------------
// Public API — execute a GraphQL operation
// ---------------------------------------------------------------------------

export const invoke = Effect.fn("GraphQL.invoke")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  config: InvocationConfig,
  resolvedHeaders?: Record<string, string>,
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

  let request = HttpClientRequest.post(config.endpoint).pipe(
    HttpClientRequest.setHeader("Content-Type", "application/json"),
    HttpClientRequest.bodyUnsafeJson({
      query: operation.operationString,
      variables: Object.keys(variables).length > 0 ? variables : undefined,
    }),
  );

  // Apply resolved headers
  if (resolvedHeaders) {
    for (const [name, value] of Object.entries(resolvedHeaders)) {
      request = HttpClientRequest.setHeader(request, name, value);
    }
  }

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new GraphqlInvocationError({
          message: `GraphQL request failed: ${err.message}`,
          statusCode: Option.none(),
          error: err,
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
// ToolInvoker — bridges operation store + HTTP client into SDK invoker
// ---------------------------------------------------------------------------

export const makeGraphqlInvoker = (opts: {
  readonly operationStore: GraphqlOperationStore;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
  readonly secrets: { readonly resolve: (secretId: SecretId, scopeId: ScopeId) => Effect.Effect<string, unknown> };
  readonly scopeId: ScopeId;
}): ToolInvoker => ({
  resolveAnnotations: (toolId: ToolId) =>
    Effect.gen(function* () {
      const entry = yield* opts.operationStore.get(toolId);
      if (!entry) return undefined;
      // Mutations require approval, queries don't
      if (entry.binding.kind === "mutation") {
        return {
          requiresApproval: true,
          approvalDescription: `mutation ${entry.binding.fieldName}`,
        };
      }
      return {};
    }),

  invoke: (toolId: ToolId, args: unknown) =>
    Effect.gen(function* () {
      const entry = yield* opts.operationStore.get(toolId);
      if (!entry) {
        return yield* new ToolInvocationError({
          toolId,
          message: `No GraphQL operation found for tool "${toolId}"`,
          cause: undefined,
        });
      }

      const { binding, config } = entry;

      // Resolve secret-backed headers
      const resolvedHeaders = yield* resolveHeaders(
        config.headers,
        opts.secrets,
        opts.scopeId,
      );

      const result = yield* invoke(
        binding,
        (args ?? {}) as Record<string, unknown>,
        config,
        resolvedHeaders,
      ).pipe(Effect.provide(opts.httpClientLayer));

      return new ToolInvocationResult({
        data: result.data,
        error: result.errors,
        status: result.status,
      });
    }).pipe(
      Effect.catchAll((err) => {
        if (
          typeof err === "object" &&
          err !== null &&
          "_tag" in err &&
          (err as { _tag: string })._tag === "ToolInvocationError"
        ) {
          return Effect.fail(err as ToolInvocationError);
        }
        return Effect.fail(
          new ToolInvocationError({
            toolId,
            message: `GraphQL invocation failed: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          }),
        );
      }),
    ),
});
