import { Result, TaggedError } from "better-result";
import { z } from "zod";

const recordSchema = z.record(z.unknown());

function toRecord(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

type OpenApiRequestErrorArgs = {
  status: number | null;
  message: string;
};

type GraphqlRequestErrorArgs = {
  message: string;
};

class OpenApiRequestError extends TaggedError("OpenApiRequestError")<OpenApiRequestErrorArgs>() {}

class GraphqlRequestError extends TaggedError("GraphqlRequestError")<GraphqlRequestErrorArgs>() {}

export interface OpenApiRequestRunSpec {
  baseUrl: string;
  method: string;
  pathTemplate: string;
  parameters: Array<{
    name: string;
    in: string;
    required?: boolean;
    style?: string;
    explode?: boolean;
    allowReserved?: boolean;
  }>;
  authHeaders: Record<string, string>;
}

export interface GraphqlExecutionEnvelope {
  data: unknown;
  errors: unknown[];
}

function isMcpReconnectableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(socket|closed|ECONNRESET|fetch failed)/i.test(message);
}

export async function callMcpToolWithReconnect(
  call: () => Promise<unknown>,
  reconnectAndCall: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    if (!isMcpReconnectableError(error)) {
      throw error;
    }
    return await reconnectAndCall();
  }
}

type OpenApiParameterPair = {
  key: string;
  value: string;
  allowReserved: boolean;
};

type OpenApiInputBuckets = {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  cookie: Record<string, unknown>;
  body: unknown;
};

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function stringifyParameterValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

function normalizeStyle(parameter: OpenApiRequestRunSpec["parameters"][number]): string {
  const style = (parameter.style ?? "").trim();
  if (style.length > 0) return style;
  if (parameter.in === "query" || parameter.in === "cookie") return "form";
  return "simple";
}

function normalizeExplode(parameter: OpenApiRequestRunSpec["parameters"][number], style: string): boolean {
  if (typeof parameter.explode === "boolean") return parameter.explode;
  return style === "form";
}

function serializeArray(
  name: string,
  value: unknown[],
  parameter: OpenApiRequestRunSpec["parameters"][number],
  inLocation: "query" | "header" | "cookie" | "path",
): OpenApiParameterPair[] {
  const style = normalizeStyle(parameter);
  const explode = normalizeExplode(parameter, style);
  const allowReserved = Boolean(parameter.allowReserved);
  const scalarValues = value.map((entry) => stringifyParameterValue(entry));

  if (inLocation === "query" && style === "spaceDelimited") {
    return [{ key: name, value: scalarValues.join(" "), allowReserved }];
  }
  if (inLocation === "query" && style === "pipeDelimited") {
    return [{ key: name, value: scalarValues.join("|"), allowReserved }];
  }

  if (explode && inLocation === "query") {
    return scalarValues.map((entry) => ({ key: name, value: entry, allowReserved }));
  }

  return [{ key: name, value: scalarValues.join(","), allowReserved }];
}

function serializeObject(
  name: string,
  value: Record<string, unknown>,
  parameter: OpenApiRequestRunSpec["parameters"][number],
  inLocation: "query" | "header" | "cookie" | "path",
): OpenApiParameterPair[] {
  const style = normalizeStyle(parameter);
  const explode = normalizeExplode(parameter, style);
  const allowReserved = Boolean(parameter.allowReserved);
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return [{ key: name, value: "", allowReserved }];
  }

  if (inLocation === "query" && style === "deepObject") {
    return entries.map(([key, raw]) => ({
      key: `${name}[${key}]`,
      value: stringifyParameterValue(raw),
      allowReserved,
    }));
  }

  if (explode && inLocation === "query" && style === "form") {
    return entries.map(([key, raw]) => ({
      key,
      value: stringifyParameterValue(raw),
      allowReserved,
    }));
  }

  if (explode) {
    return [{
      key: name,
      value: entries.map(([key, raw]) => `${key}=${stringifyParameterValue(raw)}`).join(","),
      allowReserved,
    }];
  }

  return [{
    key: name,
    value: entries.flatMap(([key, raw]) => [key, stringifyParameterValue(raw)]).join(","),
    allowReserved,
  }];
}

function serializeParameter(
  name: string,
  rawValue: unknown,
  parameter: OpenApiRequestRunSpec["parameters"][number],
  inLocation: "query" | "header" | "cookie" | "path",
): OpenApiParameterPair[] {
  if (Array.isArray(rawValue)) {
    return serializeArray(name, rawValue, parameter, inLocation);
  }

  if (rawValue && typeof rawValue === "object") {
    return serializeObject(name, toRecord(rawValue), parameter, inLocation);
  }

  return [{
    key: name,
    value: stringifyParameterValue(rawValue),
    allowReserved: Boolean(parameter.allowReserved),
  }];
}

function encodeAllowReservedQueryComponent(value: string, allowReserved: boolean): string {
  const encoded = encodeURIComponent(value);
  if (!allowReserved) return encoded;

  return encoded
    .replace(/%3A/gi, ":")
    .replace(/%2F/gi, "/")
    .replace(/%3F/gi, "?")
    .replace(/%23/gi, "#")
    .replace(/%5B/gi, "[")
    .replace(/%5D/gi, "]")
    .replace(/%40/gi, "@")
    .replace(/%21/gi, "!")
    .replace(/%24/gi, "$")
    .replace(/%26/gi, "&")
    .replace(/%27/gi, "'")
    .replace(/%28/gi, "(")
    .replace(/%29/gi, ")")
    .replace(/%2A/gi, "*")
    .replace(/%2B/gi, "+")
    .replace(/%2C/gi, ",")
    .replace(/%3B/gi, ";")
    .replace(/%3D/gi, "=");
}

function toOpenApiInputBuckets(input: Record<string, unknown>): OpenApiInputBuckets {
  return {
    path: toRecord(input.path),
    query: toRecord(input.query),
    headers: toRecord(input.headers),
    cookie: toRecord(input.cookie),
    body: hasOwnKey(input, "body") ? input.body : undefined,
  };
}

function buildOpenApiRequestParts(
  baseUrl: string,
  pathTemplate: string,
  parameters: OpenApiRequestRunSpec["parameters"],
  input: OpenApiInputBuckets,
): {
  url: string;
  bodyInput: unknown;
  headerParameters: Record<string, string>;
  cookiePairs: OpenApiParameterPair[];
} {
  let resolvedPath = pathTemplate;
  const queryPairs: OpenApiParameterPair[] = [];
  const headerParameters: Record<string, string> = {};
  const cookiePairs: OpenApiParameterPair[] = [];

  for (const parameter of parameters) {
    const sourceRecord = parameter.in === "path"
      ? input.path
      : parameter.in === "query"
        ? input.query
        : parameter.in === "header"
          ? input.headers
          : parameter.in === "cookie"
            ? input.cookie
            : {};

    if (!hasOwnKey(sourceRecord, parameter.name)) {
      if (parameter.required) {
        throw new Error(`Missing required ${parameter.in} parameter '${parameter.name}'`);
      }
      continue;
    }

    const value = sourceRecord[parameter.name];
    if (value === undefined || value === null) {
      if (parameter.required) {
        throw new Error(`Missing required ${parameter.in} parameter '${parameter.name}'`);
      }
      continue;
    }

    const pairs = serializeParameter(
      parameter.name,
      value,
      parameter,
      parameter.in === "path" || parameter.in === "query" || parameter.in === "header" || parameter.in === "cookie"
        ? parameter.in
        : "query",
    );

    if (parameter.in === "path") {
      const encodedValue = encodeURIComponent(pairs[0]?.value ?? "");
      resolvedPath = resolvedPath.replace(`{${parameter.name}}`, encodedValue);
      continue;
    }

    if (parameter.in === "query") {
      queryPairs.push(...pairs);
      continue;
    }

    if (parameter.in === "header") {
      const headerValue = pairs.map((pair) => pair.value).join(",");
      if (headerValue.length > 0) {
        headerParameters[parameter.name] = headerValue;
      }
      continue;
    }

    if (parameter.in === "cookie") {
      cookiePairs.push(...pairs.map((pair) => ({ ...pair, key: parameter.name })));
    }
  }

  const url = new URL(`${baseUrl.replace(/\/$/, "")}${resolvedPath}`);
  if (queryPairs.length > 0) {
    url.search = queryPairs
      .map((pair) => `${encodeURIComponent(pair.key)}=${encodeAllowReservedQueryComponent(pair.value, pair.allowReserved)}`)
      .join("&");
  }

  return {
    url: url.toString(),
    bodyInput: input.body,
    headerParameters,
    cookiePairs,
  };
}

export async function executeOpenApiRequest(
  runSpec: OpenApiRequestRunSpec,
  input: unknown,
  credentialHeaders?: Record<string, string>,
): Promise<Result<unknown, OpenApiRequestError>> {
  const payload = toRecord(input);
  const buckets = toOpenApiInputBuckets(payload);
  const readMethods = new Set(["get", "head", "options"]);
  let parts: ReturnType<typeof buildOpenApiRequestParts>;
  try {
    parts = buildOpenApiRequestParts(
      runSpec.baseUrl,
      runSpec.pathTemplate,
      runSpec.parameters,
      buckets,
    );
  } catch (error) {
    return Result.err(new OpenApiRequestError({
      status: null,
      message: error instanceof Error ? error.message : String(error),
    }));
  }

  const hasBody = !readMethods.has(runSpec.method)
    && parts.bodyInput !== undefined
    && parts.bodyInput !== null
    && !(typeof parts.bodyInput === "object" && !Array.isArray(parts.bodyInput) && Object.keys(toRecord(parts.bodyInput)).length === 0);

  const requestHeaders: Record<string, string> = {
    ...runSpec.authHeaders,
    ...(credentialHeaders ?? {}),
    ...parts.headerParameters,
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };

  if (parts.cookiePairs.length > 0) {
    const cookieHeader = parts.cookiePairs
      .map((pair) => `${pair.key}=${pair.value}`)
      .join("; ");
    if (cookieHeader.length > 0) {
      const existing = requestHeaders.Cookie ?? requestHeaders.cookie;
      requestHeaders.Cookie = existing && existing.trim().length > 0
        ? `${existing}; ${cookieHeader}`
        : cookieHeader;
    }
  }

  const request = Result.try(() => ({
    method: runSpec.method.toUpperCase(),
    headers: requestHeaders,
    body: hasBody ? JSON.stringify(parts.bodyInput) : undefined,
  }));
  if (request.isErr()) {
    return Result.err(new OpenApiRequestError({
      status: null,
      message: request.error.message,
    }));
  }

  const responseResult = await Result.tryPromise(async () => fetch(parts.url, request.value));
  if (responseResult.isErr()) {
    const cause = responseResult.error.cause;
    return Result.err(new OpenApiRequestError({
      status: null,
      message: `OpenAPI request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    }));
  }

  const response = responseResult.value;

  if (!response.ok) {
    const textResult = await Result.tryPromise(() => response.text());
    const text = textResult.isOk() ? textResult.value.slice(0, 500) : "";
    return Result.err(new OpenApiRequestError({
      status: response.status,
      message: `HTTP ${response.status} ${response.statusText}: ${text}`,
    }));
  }

  const contentType = response.headers.get("content-type") ?? "";
  const bodyResult = contentType.includes("json")
    ? await Result.tryPromise(async () => response.json() as Promise<unknown>)
    : await Result.tryPromise(() => response.text() as Promise<string>);

  if (bodyResult.isErr()) {
    return Result.err(new OpenApiRequestError({
      status: response.status,
      message: `Failed to read OpenAPI response body: ${
        bodyResult.error instanceof Error ? bodyResult.error.message : String(bodyResult.error)
      }`,
    }));
  }

  return Result.ok(bodyResult.value);
}

function hasGraphqlData(data: unknown): boolean {
  if (data === null || data === undefined) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data === "object") return Object.keys(toRecord(data)).length > 0;
  return true;
}

function normalizeGraphqlEnvelope(result: { data?: unknown; errors?: unknown[] }): GraphqlExecutionEnvelope {
  return {
    data: result.data ?? null,
    errors: Array.isArray(result.errors) ? result.errors : [],
  };
}

export async function executeGraphqlRequest(
  endpoint: string,
  authHeaders: Record<string, string>,
  query: string,
  variables: unknown,
  credentialHeaders?: Record<string, string>,
): Promise<Result<GraphqlExecutionEnvelope, GraphqlRequestError>> {
  const responseResult = await Result.tryPromise(async () => fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
      ...(credentialHeaders ?? {}),
    },
    body: JSON.stringify({ query, variables }),
  }));

  if (responseResult.isErr()) {
    const cause = responseResult.error.cause;
    return Result.err(new GraphqlRequestError({
      message: `GraphQL request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    }));
  }

  const response = responseResult.value;

  if (!response.ok) {
    const textResult = await Result.tryPromise(() => response.text());
    const text = textResult.isOk() ? textResult.value : "";
    return Result.err(new GraphqlRequestError({
      message: `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
    }));
  }

  const result = await Result.tryPromise(async () =>
    response.json() as Promise<{ data?: unknown; errors?: unknown[] }>
  );
  if (result.isErr()) {
    return Result.err(new GraphqlRequestError({
      message: `Failed to parse GraphQL response: ${
        result.error instanceof Error ? result.error.message : String(result.error)
      }`,
    }));
  }

  const decoded = result.value;
  if (decoded.errors && !hasGraphqlData(decoded.data)) {
    return Result.err(new GraphqlRequestError({
      message: `GraphQL errors: ${JSON.stringify(decoded.errors).slice(0, 1000)}`,
    }));
  }

  return Result.ok(normalizeGraphqlEnvelope(decoded));
}
