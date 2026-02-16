import { Result, TaggedError } from "better-result";
import { asRecord } from "../utils";

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
  parameters: Array<{ name: string; in: string }>;
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

function buildOpenApiUrl(
  baseUrl: string,
  pathTemplate: string,
  parameters: Array<{ name: string; in: string }>,
  input: Record<string, unknown>,
): { url: string; bodyInput: Record<string, unknown> } {
  let resolvedPath = pathTemplate;
  const bodyInput = { ...input };
  const searchParams = new URLSearchParams();

  for (const parameter of parameters) {
    const value = input[parameter.name];
    if (value === undefined) continue;

    if (parameter.in === "path") {
      resolvedPath = resolvedPath.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
      delete bodyInput[parameter.name];
      continue;
    }

    if (parameter.in === "query") {
      searchParams.set(parameter.name, String(value));
      delete bodyInput[parameter.name];
    }
  }

  const url = new URL(`${baseUrl.replace(/\/$/, "")}${resolvedPath}`);
  for (const [key, value] of searchParams.entries()) {
    url.searchParams.set(key, value);
  }

  return {
    url: url.toString(),
    bodyInput,
  };
}

export async function executeOpenApiRequest(
  runSpec: OpenApiRequestRunSpec,
  input: unknown,
  credentialHeaders?: Record<string, string>,
): Promise<Result<unknown, OpenApiRequestError>> {
  const payload = asRecord(input);
  const readMethods = new Set(["get", "head", "options"]);
  const { url, bodyInput } = buildOpenApiUrl(
    runSpec.baseUrl,
    runSpec.pathTemplate,
    runSpec.parameters,
    payload,
  );
  const hasBody = !readMethods.has(runSpec.method) && Object.keys(bodyInput).length > 0;

  const request = Result.try(() => ({
    method: runSpec.method.toUpperCase(),
    headers: {
      ...runSpec.authHeaders,
      ...(credentialHeaders ?? {}),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(bodyInput) : undefined,
  }));
  if (request.isErr()) {
    return Result.err(new OpenApiRequestError({
      status: null,
      message: request.error.message,
    }));
  }

  const responseResult = await Result.tryPromise(async () => fetch(url, request.value));
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
  if (typeof data === "object") return Object.keys(data as Record<string, unknown>).length > 0;
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
