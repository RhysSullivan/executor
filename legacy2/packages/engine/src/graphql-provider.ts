import type {
  CanonicalToolDescriptor,
  Source,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import {
  collectSourceHeaders,
  parseSourceConfig,
  readStringRecord,
  resolveSourceEndpoint,
} from "./source-config";
import { ToolProviderError, type ToolProvider } from "./tool-providers";

const GraphqlInvocationPayloadSchema = Schema.Struct({
  kind: Schema.Literal("graphql_request"),
});

const GraphqlInvokeArgsSchema = Schema.Struct({
  query: Schema.String,
  variables: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
  ),
  operationName: Schema.optional(Schema.String),
  headers: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

const decodeGraphqlInvocationPayload = Schema.decodeUnknown(GraphqlInvocationPayloadSchema);
const decodeGraphqlInvokeArgs = Schema.decodeUnknown(GraphqlInvokeArgsSchema);

const toGraphqlProviderError = (
  operation: string,
  message: string,
  cause: unknown,
): ToolProviderError =>
  new ToolProviderError({
    operation,
    providerKind: "graphql",
    message,
    details: ParseResult.isParseError(cause)
      ? ParseResult.TreeFormatter.formatErrorSync(cause)
      : String(cause),
  });

const parseGraphqlResponseBody = (
  response: Response,
): Effect.Effect<unknown, ToolProviderError> =>
  Effect.tryPromise({
    try: async () => {
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("application/json")) {
        return await response.json();
      }

      return await response.text();
    },
    catch: (cause) =>
      toGraphqlProviderError(
        "invoke.decode_response",
        "Failed to decode GraphQL response body",
        cause,
      ),
  });

const hasGraphqlErrors = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Array.isArray((value as { errors?: unknown }).errors);
};

const descriptorForSource = (source: Source): CanonicalToolDescriptor => ({
  providerKind: "graphql",
  sourceId: source.id,
  workspaceId: source.workspaceId,
  toolId: "request",
  name: "GraphQL request",
  description: "Execute a GraphQL operation with args.query, args.variables, and args.operationName.",
  invocationMode: "graphql",
  availability: "remote_capable",
  providerPayload: {
    kind: "graphql_request",
  },
});

export const makeGraphqlToolProvider = (): ToolProvider => ({
  kind: "graphql",

  discoverFromSource: (source) =>
    Effect.succeed({
      sourceHash: source.sourceHash,
      tools: [descriptorForSource(source)],
    }),

  invoke: (input) =>
    Effect.gen(function* () {
      if (!input.source) {
        return yield* new ToolProviderError({
          operation: "invoke.validate_source",
          providerKind: "graphql",
          message: "GraphQL provider requires a source",
          details: null,
        });
      }
      const source = input.source;

      yield* decodeGraphqlInvocationPayload(input.tool.providerPayload).pipe(
        Effect.mapError((cause) =>
          toGraphqlProviderError(
            "invoke.decode_payload",
            `Invalid GraphQL invocation payload for tool: ${input.tool.toolId}`,
            cause,
          ),
        ),
      );

      const args = yield* decodeGraphqlInvokeArgs(input.args).pipe(
        Effect.mapError((cause) =>
          toGraphqlProviderError(
            "invoke.decode_args",
            `Invalid GraphQL args for tool: ${input.tool.toolId}`,
            cause,
          ),
        ),
      );

      const query = args.query.trim();
      if (query.length === 0) {
        return yield* new ToolProviderError({
          operation: "invoke.validate_args",
          providerKind: "graphql",
          message: "GraphQL query must be non-empty",
          details: input.tool.toolId,
        });
      }

      const config = parseSourceConfig(source);
      const endpoint = resolveSourceEndpoint(source, config, ["endpoint", "url"]);
      if (endpoint.trim().length === 0) {
        return yield* new ToolProviderError({
          operation: "invoke.validate_source",
          providerKind: "graphql",
          message: "GraphQL source endpoint is required",
          details: source.id,
        });
      }

      const headers = new Headers({
        "content-type": "application/json",
        ...collectSourceHeaders(config),
        ...readStringRecord(args.headers),
        ...(input.credentialHeaders ?? {}),
      });

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
              query,
              variables: args.variables,
              operationName: args.operationName,
            }),
          }),
        catch: (cause) =>
          toGraphqlProviderError(
            "invoke.http_request",
            `GraphQL request failed for source: ${source.name}`,
            cause,
          ),
      });

      const body = yield* parseGraphqlResponseBody(response);

      return {
        output: {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
        },
        isError: response.status >= 400 || hasGraphqlErrors(body),
      };
    }),
});
