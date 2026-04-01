import { Effect, Match, Option } from "effect";

import { OpenApiInvocationError } from "./errors";
import {
  type AuthConfig,
  type ExtractedOperation,
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
// URL construction
// ---------------------------------------------------------------------------

const buildUrl = (baseUrl: string, resolvedPath: string): URL => {
  try {
    return new URL(resolvedPath);
  } catch {
    const base = new URL(baseUrl);
    const basePath =
      base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
    const pathPart = resolvedPath.startsWith("/")
      ? resolvedPath
      : `/${resolvedPath}`;
    base.pathname = `${basePath}${pathPart}`.replace(/\/{2,}/g, "/");
    base.search = "";
    base.hash = "";
    return base;
  }
};

// ---------------------------------------------------------------------------
// Auth application
// ---------------------------------------------------------------------------

const applyAuth = (headers: Headers, url: URL, auth: AuthConfig): void =>
  Match.valueTags(auth, {
    NoAuth: () => {},
    BearerAuth: ({ token, headerName, prefix }) => {
      headers.set(headerName, `${prefix}${token}`);
    },
    ApiKeyAuth: ({ name, value, in: location }) => {
      if (location === "header") {
        headers.set(name, value);
      } else if (location === "query") {
        url.searchParams.set(name, value);
      } else {
        const existing = headers.get("cookie");
        const cookie = `${name}=${encodeURIComponent(value)}`;
        headers.set("cookie", existing ? `${existing}; ${cookie}` : cookie);
      }
    },
  });

// ---------------------------------------------------------------------------
// Response decoding
// ---------------------------------------------------------------------------

const isJsonContentType = (ct: string | null): boolean => {
  if (!ct) return false;
  const normalized = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    normalized === "application/json" ||
    normalized.includes("+json") ||
    normalized.includes("json")
  );
};

const decodeResponse = (
  response: Response,
): Effect.Effect<unknown, OpenApiInvocationError> =>
  Effect.tryPromise({
    try: async () => {
      if (response.status === 204) return null;
      if (isJsonContentType(response.headers.get("content-type"))) {
        return response.json();
      }
      return response.text();
    },
    catch: (error) =>
      new OpenApiInvocationError({
        message: `Failed to decode response body: ${error instanceof Error ? error.message : String(error)}`,
        statusCode: Option.some(response.status),
        error,
      }),
  });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Invoke an extracted OpenAPI operation */
export const invoke = Effect.fn("OpenApi.invoke")(function* (
  operation: ExtractedOperation,
  args: Record<string, unknown>,
  config: InvocationConfig,
) {
  const resolvedPath = yield* resolvePath(
    operation.pathTemplate,
    args,
    operation.parameters,
  );

  const url = buildUrl(config.baseUrl, resolvedPath);
  const headers = new Headers();

  // Query parameters
  for (const param of operation.parameters) {
    if (param.location !== "query") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    url.searchParams.set(param.name, String(value));
  }

  // Header parameters
  for (const param of operation.parameters) {
    if (param.location !== "header") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    headers.set(param.name, String(value));
  }

  // Request body
  let body: string | undefined;
  if (Option.isSome(operation.requestBody)) {
    const rb = operation.requestBody.value;
    const bodyValue = args.body ?? args.input;
    if (bodyValue !== undefined) {
      headers.set("content-type", rb.contentType);
      // eslint-disable-next-line effect/preferSchemaOverJson -- serializing arbitrary user-provided body for HTTP transport
      body = isJsonContentType(rb.contentType)
        ? JSON.stringify(bodyValue)
        : String(bodyValue);
    }
  }

  // Auth
  applyAuth(headers, url, config.auth);

  // Execute request
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(url.toString(), {
        method: operation.method.toUpperCase(),
        headers,
        ...(body !== undefined ? { body } : {}),
      }),
    catch: (error) =>
      new OpenApiInvocationError({
        message: `HTTP request failed: ${error instanceof Error ? error.message : String(error)}`,
        statusCode: Option.none(),
        error,
      }),
  });

  const responseBody = yield* decodeResponse(response);

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return new InvocationResult({
    status: response.status,
    headers: responseHeaders,
    data: response.ok ? responseBody : null,
    error: response.ok ? null : responseBody,
  });
});
