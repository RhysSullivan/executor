import { Effect, Layer, Option } from "effect";
import {
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";

import {
  type ToolId,
  type ToolInvoker,
  ToolInvocationResult,
  ToolInvocationError,
  type ScopeId,
  type SecretId,
} from "@executor/sdk";

import { OpenApiInvocationError } from "./errors";
import type { OpenApiOperationStore } from "./operation-store";
import {
  type HeaderValue,
  type OperationBinding,
  InvocationConfig,
  InvocationResult,
  type OperationParameter,
} from "./types";

// ---------------------------------------------------------------------------
// Parameter reading
// ---------------------------------------------------------------------------

const CONTAINER_KEYS: Record<string, readonly string[]> = {
  path: ["path", "pathParams", "params"],
  query: ["query", "queryParams", "params"],
  header: ["headers", "header"],
  cookie: ["cookies", "cookie"],
};

const readParamValue = (
  args: Record<string, unknown>,
  param: OperationParameter,
): unknown => {
  const direct = args[param.name];
  if (direct !== undefined) return direct;

  for (const key of CONTAINER_KEYS[param.location] ?? []) {
    const container = args[key];
    if (
      typeof container === "object" &&
      container !== null &&
      !Array.isArray(container)
    ) {
      const nested = (container as Record<string, unknown>)[param.name];
      if (nested !== undefined) return nested;
    }
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const resolvePath = Effect.fn("OpenApi.resolvePath")(function* (
  pathTemplate: string,
  args: Record<string, unknown>,
  parameters: readonly OperationParameter[],
) {
  let resolved = pathTemplate;

  // Resolve declared path parameters
  for (const param of parameters) {
    if (param.location !== "path") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) {
      if (param.required) {
        return yield* new OpenApiInvocationError({
          message: `Missing required path parameter: ${param.name}`,
          statusCode: Option.none(),
          error: undefined,
        });
      }
      continue;
    }
    resolved = resolved.replaceAll(
      `{${param.name}}`,
      encodeURIComponent(String(value)),
    );
  }

  // Resolve remaining placeholders from raw args (handles specs that
  // don't explicitly list path parameters)
  const remaining = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");

  for (const name of remaining) {
    const value = args[name];
    if (value !== undefined && value !== null) {
      resolved = resolved.replaceAll(
        `{${name}}`,
        encodeURIComponent(String(value)),
      );
    }
  }

  const unresolved = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");

  if (unresolved.length > 0) {
    return yield* new OpenApiInvocationError({
      message: `Unresolved path parameters: ${[...new Set(unresolved)].join(", ")}`,
      statusCode: Option.none(),
      error: undefined,
    });
  }

  return resolved;
});

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

const applyHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  headers: Record<string, string>,
): HttpClientRequest.HttpClientRequest => {
  let req = request;
  for (const [name, value] of Object.entries(headers)) {
    req = HttpClientRequest.setHeader(req, name, value);
  }
  return req;
};

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
// Public API
// ---------------------------------------------------------------------------

/** Invoke an OpenAPI operation binding. Requires HttpClient in the context. */
export const invoke = Effect.fn("OpenApi.invoke")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  config: InvocationConfig,
  /** Pre-resolved headers (secrets already resolved) */
  resolvedHeaders?: Record<string, string>,
) {
  const client = yield* HttpClient.HttpClient;

  const resolvedPath = yield* resolvePath(
    operation.pathTemplate,
    args,
    operation.parameters,
  );

  const path = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;

  // Build the base request — use just the path; baseUrl is applied to the client
  let request = HttpClientRequest.make(operation.method.toUpperCase() as "GET")(path);

  // Query parameters
  for (const param of operation.parameters) {
    if (param.location !== "query") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    request = HttpClientRequest.setUrlParam(
      request,
      param.name,
      String(value),
    );
  }

  // Header parameters
  for (const param of operation.parameters) {
    if (param.location !== "header") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    request = HttpClientRequest.setHeader(
      request,
      param.name,
      String(value),
    );
  }

  // Request body
  if (Option.isSome(operation.requestBody)) {
    const rb = operation.requestBody.value;
    const bodyValue = args.body ?? args.input;
    if (bodyValue !== undefined) {
      if (isJsonContentType(rb.contentType)) {
        request = HttpClientRequest.bodyUnsafeJson(request, bodyValue);
      } else {
        request = HttpClientRequest.bodyText(request, String(bodyValue), rb.contentType);
      }
    }
  }

  // Static headers (auth, custom headers, etc.) — use pre-resolved if available
  request = applyHeaders(request, resolvedHeaders ?? {});

  // Execute
  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new OpenApiInvocationError({
          message: `HTTP request failed: ${err.message}`,
          statusCode: Option.none(),
          error: err,
        }),
    ),
  );

  const status = response.status;
  const responseHeaders: Record<string, string> = { ...response.headers };

  // Decode body
  const contentType = response.headers["content-type"] ?? null;
  const responseBody: unknown =
    status === 204
      ? null
      : isJsonContentType(contentType)
        ? yield* response.json.pipe(
            Effect.catchAll(() => response.text),
          )
        : yield* response.text;

  const ok = status >= 200 && status < 300;

  return new InvocationResult({
    status,
    headers: responseHeaders,
    data: ok ? responseBody : null,
    error: ok ? null : responseBody,
  });
});

// ---------------------------------------------------------------------------
// ToolInvoker — bridges operation store + HTTP client into SDK invoker
// ---------------------------------------------------------------------------

export const makeOpenApiInvoker = (opts: {
  readonly operationStore: OpenApiOperationStore;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
  readonly secrets: { readonly resolve: (secretId: SecretId, scopeId: ScopeId) => Effect.Effect<string, unknown> };
  readonly scopeId: ScopeId;
}): ToolInvoker => ({
  invoke: (toolId: ToolId, args: unknown, _options) =>
    Effect.gen(function* () {
      const entry = yield* opts.operationStore.get(toolId);
      if (!entry) {
        return yield* new ToolInvocationError({
          toolId,
          message: `No operation found for tool "${toolId}"`,
          cause: undefined,
        });
      }

      const { binding, config } = entry;
      const baseUrl = config.baseUrl;

      // Resolve secret-backed headers
      const resolvedHeaders = yield* resolveHeaders(
        config.headers,
        opts.secrets,
        opts.scopeId,
      );

      const clientWithBaseUrl = baseUrl
        ? Layer.effect(
            HttpClient.HttpClient,
            Effect.map(
              HttpClient.HttpClient,
              HttpClient.mapRequest(
                HttpClientRequest.prependUrl(baseUrl),
              ),
            ),
          ).pipe(Layer.provide(opts.httpClientLayer))
        : opts.httpClientLayer;

      const result = yield* invoke(
        binding,
        (args ?? {}) as Record<string, unknown>,
        config,
        resolvedHeaders,
      ).pipe(Effect.provide(clientWithBaseUrl));

      return new ToolInvocationResult({
        data: result.data,
        error: result.error,
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
            message: `OpenAPI invocation failed: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          }),
        );
      }),
    ),
});
