import {
  OpenApiInvocationPayloadSchema,
  OpenApiToolManifestSchema,
  type CanonicalToolDescriptor,
  type OpenApiCanonicalToolDescriptor,
  type OpenApiInvocationPayload,
  type OpenApiToolManifest,
  type Source,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import { collectSourceHeaders } from "./source-config";
import { ToolProviderError, type ToolProvider } from "./tool-providers";

const OpenApiToolArgsSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

type OpenApiToolArgs = typeof OpenApiToolArgsSchema.Type;
type OpenApiToolParameter = OpenApiInvocationPayload["parameters"][number];

const decodeOpenApiManifestJson = Schema.decodeUnknown(
  Schema.parseJson(OpenApiToolManifestSchema),
);
const decodeOpenApiInvocationPayload = Schema.decodeUnknown(
  OpenApiInvocationPayloadSchema,
);
const decodeOpenApiToolArgs = Schema.decodeUnknown(OpenApiToolArgsSchema);
const encodeUnknownToJson = Schema.encode(Schema.parseJson(Schema.Unknown));

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

  return String(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parameterContainerKeys: Record<OpenApiToolParameter["location"], Array<string>> = {
  path: ["path", "pathParams", "params"],
  query: ["query", "queryParams", "params"],
  header: ["headers", "header"],
  cookie: ["cookies", "cookie"],
};

const readParameterValue = (
  args: OpenApiToolArgs,
  parameter: OpenApiToolParameter,
): unknown => {
  const directValue = args[parameter.name];
  if (directValue !== undefined) {
    return directValue;
  }

  for (const key of parameterContainerKeys[parameter.location]) {
    const container = args[key];
    if (!isRecord(container)) {
      continue;
    }

    const nestedValue = container[parameter.name];
    if (nestedValue !== undefined) {
      return nestedValue;
    }
  }

  return undefined;
};

const normalizeHttpUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
};

const parseSourceConfig = (source: Source): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(source.configJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const getConfiguredBaseUrl = (source: Source): string | null => {
  const config = parseSourceConfig(source);
  const baseUrl = config.baseUrl;
  if (typeof baseUrl !== "string") {
    return null;
  }

  return normalizeHttpUrl(baseUrl);
};

const resolveBaseUrl = (
  source: Source,
): Effect.Effect<string, ToolProviderError> =>
  Effect.gen(function* () {
    const configured = getConfiguredBaseUrl(source);
    if (configured) {
      return configured;
    }

    return yield* new ToolProviderError({
      operation: "invoke.validate_source",
      providerKind: "openapi",
      message: "OpenAPI source requires configJson.baseUrl",
      details: source.id,
    });
  });

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

      const parameterValue = readParameterValue(args, parameter);
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

    const unresolvedPathParameters = [...resolvedPath.matchAll(/\{([^{}]+)\}/g)]
      .map((match) => match[1])
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    if (unresolvedPathParameters.length > 0) {
      const names = [...new Set(unresolvedPathParameters)].sort().join(", ");
      return yield* new ToolProviderError({
        operation: "invoke.resolve_path",
        providerKind: "openapi",
        message: `Unresolved path parameters after substitution: ${names}`,
        details: resolvedPath,
      });
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
  credentialHeaders: Readonly<Record<string, string>> = {},
): Effect.Effect<BuiltFetchRequest, ToolProviderError> =>
  Effect.gen(function* () {
    const resolvedPath = yield* replacePathTemplate(payload.pathTemplate, args, payload);
    const baseUrl = yield* resolveBaseUrl(source);
    const url = new URL(resolvedPath, baseUrl);
    const config = parseSourceConfig(source);

    const headers = new Headers(collectSourceHeaders(config));
    const cookieParts: Array<string> = [];

    for (const parameter of payload.parameters) {
      if (parameter.location === "path") {
        continue;
      }

      const parameterValue = readParameterValue(args, parameter);
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
        body = yield* pipe(
          encodeUnknownToJson(args.body),
          Effect.mapError((cause) =>
            toOpenApiProviderError(
              "invoke.encode_body",
              "Failed to encode request body as JSON",
              cause,
            ),
          ),
        );

        const preferredContentType = payload.requestBody.contentTypes[0];
        if (preferredContentType) {
          headers.set("content-type", preferredContentType);
        } else if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
      }
    }

    for (const [key, value] of Object.entries(credentialHeaders)) {
      headers.set(key, value);
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
    Effect.map((manifest: OpenApiToolManifest) =>
      manifest.tools.map((tool): OpenApiCanonicalToolDescriptor => ({
        providerKind: "openapi",
        sourceId: source.id,
        workspaceId: source.workspaceId,
        toolId: tool.toolId,
        name: tool.name,
        description: tool.description,
        invocationMode: "http",
        availability: "remote_capable",
        providerPayload: tool.invocation,
      })),
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

      const request = yield* buildFetchRequest(
        input.source,
        payload,
        args,
        input.credentialHeaders,
      );

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
