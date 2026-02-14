import { asRecord } from "./utils";

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
): Promise<unknown> {
  const payload = asRecord(input);
  const readMethods = new Set(["get", "head", "options"]);
  const { url, bodyInput } = buildOpenApiUrl(
    runSpec.baseUrl,
    runSpec.pathTemplate,
    runSpec.parameters,
    payload,
  );
  const hasBody = !readMethods.has(runSpec.method) && Object.keys(bodyInput).length > 0;

  const response = await fetch(url, {
    method: runSpec.method.toUpperCase(),
    headers: {
      ...runSpec.authHeaders,
      ...(credentialHeaders ?? {}),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(bodyInput) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    return await response.json();
  }
  return await response.text();
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
): Promise<GraphqlExecutionEnvelope> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
      ...(credentialHeaders ?? {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }

  const result = await response.json() as { data?: unknown; errors?: unknown[] };
  if (result.errors && !hasGraphqlData(result.data)) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors).slice(0, 1000)}`);
  }

  return normalizeGraphqlEnvelope(result);
}
