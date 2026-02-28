import type { Source } from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import {
  ToolProviderError,
  type CanonicalToolDescriptor,
  type ToolProvider,
} from "./tool-providers";

const OPEN_API_PARAMETER_LOCATIONS = [
  "path",
  "query",
  "header",
  "cookie",
] as const;

const OPEN_API_HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
] as const;

const OpenApiInvocationPayloadSchema = Schema.Struct({
  method: Schema.Literal(...OPEN_API_HTTP_METHODS),
  pathTemplate: Schema.String,
  parameters: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      location: Schema.Literal(...OPEN_API_PARAMETER_LOCATIONS),
      required: Schema.Boolean,
    }),
  ),
  requestBody: Schema.NullOr(
    Schema.Struct({
      required: Schema.Boolean,
      contentTypes: Schema.Array(Schema.String),
    }),
  ),
});

type OpenApiInvocationPayload = typeof OpenApiInvocationPayloadSchema.Type;

const OpenApiManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  sourceHash: Schema.String,
  tools: Schema.Array(
    Schema.Struct({
      toolId: Schema.String,
      name: Schema.String,
      description: Schema.NullOr(Schema.String),
      invocation: OpenApiInvocationPayloadSchema,
    }),
  ),
});

type OpenApiManifest = typeof OpenApiManifestSchema.Type;

const OpenApiToolArgsSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

type OpenApiToolArgs = typeof OpenApiToolArgsSchema.Type;

const decodeOpenApiManifestJson = Schema.decodeUnknown(
  Schema.parseJson(OpenApiManifestSchema),
);
const decodeOpenApiInvocationPayload = Schema.decodeUnknown(
  OpenApiInvocationPayloadSchema,
);
const decodeOpenApiToolArgs = Schema.decodeUnknown(OpenApiToolArgsSchema);

const toOpenApiProviderError = (
  operation: string,
  message: string,
  cause: unknown,
): ToolProviderError =>
  new ToolProviderError({
    operation,
    providerKind: "openapi",
    message,
    details: ParseResult.isParseError(cause)
      ? ParseResult.TreeFormatter.formatErrorSync(cause)
      : String(cause),
  });

const encodePathSegment = (value: unknown): string =>
  encodeURIComponent(String(value));

const argsValueToString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  return JSON.stringify(value);
};

const replacePathTemplate = (
  pathTemplate: string,
  args: OpenApiToolArgs,
  payload: OpenApiInvocationPayload,
): Effect.Effect<string, ToolProviderError> =>
  Effect.gen(function* () {
    let resolvedPath = pathTemplate;

    for (const parameter of payload.parameters) {
      if (parameter.location !== "path") {
        continue;
      }

      const parameterValue = args[parameter.name];
      if (parameterValue === undefined || parameterValue === null) {
        if (parameter.required) {
          return yield* new ToolProviderError({
            operation: "invoke.resolve_path",
            providerKind: "openapi",
            message: `Missing required path parameter: ${parameter.name}`,
            details: pathTemplate,
          });
        }
        continue;
      }

      resolvedPath = resolvedPath.replaceAll(
        `{${parameter.name}}`,
        encodePathSegment(parameterValue),
      );
    }

    return resolvedPath;
  });

const hasRequestBody = (
  args: OpenApiToolArgs,
): args is OpenApiToolArgs & { body: unknown } =>
  Object.prototype.hasOwnProperty.call(args, "body") && args.body !== undefined;

type BuiltFetchRequest = {
  url: URL;
  init: RequestInit;
};

const buildFetchRequest = (
  source: Source,
  payload: OpenApiInvocationPayload,
  args: OpenApiToolArgs,
): Effect.Effect<BuiltFetchRequest, ToolProviderError> =>
  Effect.gen(function* () {
    const resolvedPath = yield* replacePathTemplate(payload.pathTemplate, args, payload);
    const url = new URL(resolvedPath, source.endpoint);

    const headers = new Headers();
    const cookieParts: Array<string> = [];

    for (const parameter of payload.parameters) {
      if (parameter.location === "path") {
        continue;
      }

      const parameterValue = args[parameter.name];
      if (parameterValue === undefined || parameterValue === null) {
        if (parameter.required) {
          return yield* new ToolProviderError({
            operation: "invoke.validate_args",
            providerKind: "openapi",
            message: `Missing required ${parameter.location} parameter: ${parameter.name}`,
            details: payload.pathTemplate,
          });
        }
        continue;
      }

      const encoded = argsValueToString(parameterValue);

      if (parameter.location === "query") {
        url.searchParams.set(parameter.name, encoded);
      } else if (parameter.location === "header") {
        headers.set(parameter.name, encoded);
      } else if (parameter.location === "cookie") {
        cookieParts.push(`${parameter.name}=${encodeURIComponent(encoded)}`);
      }
    }

    if (cookieParts.length > 0) {
      headers.set("cookie", cookieParts.join("; "));
    }

    let body: string | undefined;

    if (payload.requestBody !== null) {
      if (!hasRequestBody(args)) {
        if (payload.requestBody.required) {
          return yield* new ToolProviderError({
            operation: "invoke.validate_args",
            providerKind: "openapi",
            message: "Missing required request body at args.body",
            details: payload.pathTemplate,
          });
        }
      } else {
        body = JSON.stringify(args.body);

        const preferredContentType = payload.requestBody.contentTypes[0];
        if (preferredContentType) {
          headers.set("content-type", preferredContentType);
        } else if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
      }
    }

    return {
      url,
      init: {
        method: payload.method.toUpperCase(),
        headers,
        body,
      },
    };
  });

const decodeFetchResponseBody = (
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
      new ToolProviderError({
        operation: "invoke.decode_response",
        providerKind: "openapi",
        message: "Failed to decode OpenAPI response body",
        details: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export const openApiToolDescriptorsFromManifest = (
  source: Source,
  manifestJson: string,
): Effect.Effect<ReadonlyArray<CanonicalToolDescriptor>, ToolProviderError> =>
  pipe(
    decodeOpenApiManifestJson(manifestJson),
    Effect.mapError((cause) =>
      toOpenApiProviderError(
        "discover.decode_manifest",
        "Failed to decode OpenAPI manifest JSON",
        cause,
      ),
    ),
    Effect.map((manifest: OpenApiManifest) =>
      manifest.tools.map(
        (tool): CanonicalToolDescriptor => ({
          providerKind: "openapi",
          sourceId: source.id,
          workspaceId: source.workspaceId,
          toolId: tool.toolId,
          name: tool.name,
          description: tool.description,
          invocationMode: "http",
          availability: "remote_capable",
          providerPayload: tool.invocation,
        }),
      ),
    ),
  );

export const makeOpenApiToolProvider = (): ToolProvider => ({
  kind: "openapi",

  invoke: (input) =>
    Effect.gen(function* () {
      if (!input.source) {
        return yield* new ToolProviderError({
          operation: "invoke.validate_source",
          providerKind: "openapi",
          message: "OpenAPI provider requires a source",
          details: null,
        });
      }

      const payload = yield* pipe(
        decodeOpenApiInvocationPayload(input.tool.providerPayload),
        Effect.mapError((cause) =>
          toOpenApiProviderError(
            "invoke.decode_payload",
            `Invalid provider payload for tool: ${input.tool.toolId}`,
            cause,
          ),
        ),
      );

      const args = yield* pipe(
        decodeOpenApiToolArgs(input.args),
        Effect.mapError((cause) =>
          toOpenApiProviderError(
            "invoke.decode_args",
            `Invalid tool args for tool: ${input.tool.toolId}`,
            cause,
          ),
        ),
      );

      const request = yield* buildFetchRequest(input.source, payload, args);

      const response = yield* Effect.tryPromise({
        try: () => fetch(request.url, request.init),
        catch: (cause) =>
          toOpenApiProviderError(
            "invoke.http_request",
            `OpenAPI request failed for tool: ${input.tool.toolId}`,
            cause,
          ),
      });

      const body = yield* decodeFetchResponseBody(response);

      return {
        output: {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
        },
        isError: response.status >= 400,
      };
    }),
});
