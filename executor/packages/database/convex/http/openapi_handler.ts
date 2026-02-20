import { makeFunctionReference } from "convex/server";
import { httpAction } from "../_generated/server";
import { buildOpenApiDocument } from "./openapi_spec";
import type { FunctionType } from "./openapi_spec";
import { collectPublicFunctionSpecs } from "./openapi_spec_registry";

type OpenApiPayload = {
  path?: string;
  function?: string;
  args?: unknown;
  format?: string;
  type?: string;
  [key: string]: unknown;
};

type HttpActionCtx = Parameters<Parameters<typeof httpAction>[0]>[0];

type ActionError = Error & {
  data?: unknown;
};

const JSON_FORMAT = "json";
const OPENAPI_SPEC_PATH = "/api/openapi.json";
const API_RUN_PREFIX = "/api/run/";
const API_PREFIX = "/api/";
const CONTROL_QUERY_PARAMS = new Set(["format", "path", "function", "type", "args"]);

function parseRunPathToFunctionIdentifier(rawPath: string): string {
  const normalizedPath = rawPath.replace(/^\/+|\/+$/g, "");
  if (!normalizedPath) {
    throw new Error("Function path is required");
  }

  if (normalizedPath.includes(":")) {
    const [modulePathRaw, exportNameRaw] = decodeURIComponent(normalizedPath).split(":");
    if (!modulePathRaw) {
      throw new Error("Function path is required");
    }

    const modulePath = modulePathRaw.endsWith(".ts")
      ? modulePathRaw.slice(0, -3)
      : modulePathRaw;

    if (!exportNameRaw || exportNameRaw === "default") {
      return modulePath;
    }

    return `${modulePath}:${exportNameRaw}`;
  }

  if (normalizedPath.endsWith(".ts")) {
    return decodeURIComponent(normalizedPath.slice(0, -3));
  }

  const segments = normalizedPath.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (segments.length === 0) {
    throw new Error("Function path is required");
  }

  if (segments.length === 1) {
    return segments[0]!;
  }

  const exportName = segments[segments.length - 1]!;
  const modulePath = segments.slice(0, -1).join("/");
  return exportName === "default" ? modulePath : `${modulePath}:${exportName}`;
}

function functionIdentifierFromUrlPath(pathname: string): string | undefined {
  if (pathname.startsWith(API_RUN_PREFIX)) {
    return parseRunPathToFunctionIdentifier(pathname.slice(API_RUN_PREFIX.length));
  }

  if (pathname === "/api" || pathname === "/api/") {
    return undefined;
  }

  if (pathname.startsWith(API_PREFIX)) {
    return parseRunPathToFunctionIdentifier(pathname.slice(API_PREFIX.length));
  }

  return undefined;
}

function toActionError(error: unknown): ActionError {
  if (error instanceof Error) {
    return error as ActionError;
  }
  return new Error("Unknown function error");
}

function isTypeLookupError(error: unknown, type: FunctionType): boolean {
  const message = toActionError(error).message;
  return message.startsWith(`No ${type} named`)
    || message.startsWith("Could not find public function")
    || message.startsWith("Could not find function")
    || message.includes(`is not a ${type}`)
    || message.includes("Function not found");
}

function isLookupError(error: unknown): boolean {
  const message = toActionError(error).message;
  return message.startsWith("No query named")
    || message.startsWith("No mutation named")
    || message.startsWith("No action named")
    || message.startsWith("Could not find public function")
    || message.startsWith("Could not find function")
    || message.includes("is not a query")
    || message.includes("is not a mutation")
    || message.includes("is not an action")
    || message.includes("Function not found");
}

function errorResponse(errorMessage: string, status = 400): Response {
  return Response.json(
    {
      errorMessage,
    },
    { status },
  );
}

function functionErrorResponse(error: unknown, status?: number): Response {
  const actionError = toActionError(error);
  const resolvedStatus = status ?? (isLookupError(actionError) ? 404 : 500);

  return Response.json(
    {
      errorMessage: actionError.message,
      ...(actionError.data === undefined ? {} : { errorData: actionError.data }),
    },
    { status: resolvedStatus },
  );
}

function successResponse(value: unknown): Response {
  return Response.json(value === undefined ? null : value, { status: 200 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFunctionType(value: unknown): value is FunctionType {
  return value === "query" || value === "mutation" || value === "action";
}

function parseQueryValue(rawValue: string): unknown {
  const value = rawValue.trim();
  const looksJson = value.startsWith("{")
    || value.startsWith("[")
    || value === "true"
    || value === "false"
    || value === "null"
    || /^-?\d+(?:\.\d+)?$/.test(value)
    || /^".*"$/.test(value);

  if (looksJson) {
    try {
      return JSON.parse(value);
    } catch {
      return rawValue;
    }
  }

  return rawValue;
}

function mergeQueryParam(args: Record<string, unknown>, key: string, value: unknown): void {
  const existing = args[key];
  if (existing === undefined) {
    args[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }

  args[key] = [existing, value];
}

async function parsePostPayload(request: Request): Promise<OpenApiPayload> {
  const rawBody = await request.text();
  if (rawBody.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(rawBody) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Request body must be a JSON object");
  }

  return parsed as OpenApiPayload;
}

function parseGetPayload(url: URL): OpenApiPayload {
  const format = url.searchParams.get("format") ?? undefined;
  const path = url.searchParams.get("path") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  const inlineArgs: Record<string, unknown> = {};

  for (const [key, rawValue] of url.searchParams.entries()) {
    if (CONTROL_QUERY_PARAMS.has(key)) {
      continue;
    }
    mergeQueryParam(inlineArgs, key, parseQueryValue(rawValue));
  }

  const argsParam = url.searchParams.get("args");
  let args: Record<string, unknown> | undefined;
  if (argsParam) {
    const parsedArgs = JSON.parse(argsParam) as unknown;
    if (!isRecord(parsedArgs)) {
      throw new Error("args query parameter must be a JSON object");
    }
    args = {
      ...parsedArgs,
      ...inlineArgs,
    };
  } else if (Object.keys(inlineArgs).length > 0) {
    args = inlineArgs;
  }

  return {
    ...(type ? { type } : {}),
    ...(format ? { format } : {}),
    ...(path ? { path } : {}),
    ...(args ? { args } : {}),
  };
}

function extractArgs(payload: OpenApiPayload): Record<string, unknown> {
  if (payload.args !== undefined) {
    if (!isRecord(payload.args)) {
      throw new Error("args must be an object");
    }
    return payload.args;
  }

  const directArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (CONTROL_QUERY_PARAMS.has(key)) {
      continue;
    }
    directArgs[key] = value;
  }
  return directArgs;
}

async function runAsType(
  ctx: HttpActionCtx,
  type: FunctionType,
  functionIdentifier: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (type) {
    case "query":
      return await ctx.runQuery(makeFunctionReference<"query">(functionIdentifier), args);
    case "mutation":
      return await ctx.runMutation(makeFunctionReference<"mutation">(functionIdentifier), args);
    case "action":
      return await ctx.runAction(makeFunctionReference<"action">(functionIdentifier), args);
  }
}

export const openApiHandler = httpAction(async (ctx, request) => {
  try {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === OPENAPI_SPEC_PATH) {
      const functions = await collectPublicFunctionSpecs();
      return Response.json(buildOpenApiDocument(functions, url.origin), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    const urlIdentifier = functionIdentifierFromUrlPath(url.pathname);

    const payload = request.method === "GET"
      ? parseGetPayload(url)
      : await parsePostPayload(request);

    const payloadIdentifier = payload.path ?? payload.function;
    const functionIdentifier = urlIdentifier
      ?? (typeof payloadIdentifier === "string" ? parseRunPathToFunctionIdentifier(payloadIdentifier) : undefined);

    if (!functionIdentifier) {
      return errorResponse("Function path is required. Provide /api/run/<function> or a body path field.");
    }

    const format = payload.format ?? JSON_FORMAT;
    if (format !== JSON_FORMAT) {
      return errorResponse(`Only format=\"${JSON_FORMAT}\" is supported`);
    }

    const args = extractArgs(payload);

    if (payload.type && !isFunctionType(payload.type)) {
      return errorResponse("type must be one of: query, mutation, action");
    }

    if (payload.type && isFunctionType(payload.type)) {
      try {
        const value = await runAsType(ctx, payload.type, functionIdentifier, args);
        return successResponse(value);
      } catch (error) {
        return functionErrorResponse(error, isTypeLookupError(error, payload.type) ? 404 : 500);
      }
    }

    const attemptedTypes: FunctionType[] = request.method === "GET"
      ? ["query"]
      : ["query", "mutation", "action"];

    let lookupError: unknown;
    for (const type of attemptedTypes) {
      try {
        const value = await runAsType(ctx, type, functionIdentifier, args);
        return successResponse(value);
      } catch (error) {
        if (isTypeLookupError(error, type)) {
          lookupError = error;
          continue;
        }
        return functionErrorResponse(error, 500);
      }
    }

    return functionErrorResponse(lookupError ?? new Error(`Function not found: ${functionIdentifier}`), 404);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Invalid OpenAPI request payload");
  }
});
