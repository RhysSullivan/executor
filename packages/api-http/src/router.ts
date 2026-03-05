import {
  ControlPlaneAuthHeaders,
  controlPlaneOpenApiSpec,
} from "@executor-v2/management-api";
import type { ExecuteRunInput, ExecuteRunResult } from "@executor-v2/sdk";

export type ExecutorApiPrincipal = {
  accountId: string;
  provider: "local" | "workos" | "service";
  subject: string;
  email: string | null;
  displayName: string | null;
  organizationId: string;
  workspaceId: string;
};

export const ExecutorControlPlaneBaseUrlHeader =
  "x-executor-control-plane-base-url" as const;

export type ExecutorApiHandlers = {
  handleControlPlane: (request: Request) => Promise<Response>;
  handleMcp: (request: Request, workspaceId: string) => Promise<Response>;
  handleAdminMcp?: (request: Request, workspaceId: string) => Promise<Response>;
  handleRuntimeToolCall: (request: Request) => Promise<Response>;
  executeRun: (input: ExecuteRunInput, workspaceId: string) => Promise<ExecuteRunResult>;
};

export type ExecutorApiFetchHandlerOptions = {
  handlers: ExecutorApiHandlers;
  resolvePrincipal: (request: Request) => Promise<ExecutorApiPrincipal | Response>;
  ensurePrincipal?: (principal: ExecutorApiPrincipal) => Promise<void>;
  healthServiceName?: string;
  defaultMcpWorkspaceId?: string;
};

const methodNotAllowed = (allowed: string): Response =>
  Response.json(
    {
      ok: false,
      error: `Method not allowed. Expected ${allowed}`,
    },
    { status: 405 },
  );

const notFound = (): Response =>
  Response.json(
    {
      ok: false,
      error: "Not found",
    },
    { status: 404 },
  );

const isControlPlaneMethod = (method: string): boolean =>
  method === "GET"
  || method === "POST"
  || method === "PUT"
  || method === "PATCH"
  || method === "DELETE"
  || method === "OPTIONS";

const applyPrincipalHeaders = (
  request: Request,
  principal: ExecutorApiPrincipal,
): Request => {
  const headers = new Headers(request.headers);

  headers.set(ControlPlaneAuthHeaders.accountId, principal.accountId);
  headers.set(ControlPlaneAuthHeaders.principalProvider, principal.provider);
  headers.set(ControlPlaneAuthHeaders.principalSubject, principal.subject);

  if (principal.email) {
    headers.set(ControlPlaneAuthHeaders.principalEmail, principal.email);
  }

  if (principal.displayName) {
    headers.set(ControlPlaneAuthHeaders.principalDisplayName, principal.displayName);
  }

  return new Request(request, { headers });
};

const resolveMcpWorkspaceId = (
  request: Request,
  principal: ExecutorApiPrincipal,
  fallback?: string,
): string => {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId")?.trim();
  if (workspaceId && workspaceId.length > 0) {
    return workspaceId;
  }

  return fallback ?? principal.workspaceId;
};

const parseExecuteRequest = async (request: Request): Promise<ExecuteRunInput | null> => {
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.code !== "string" || record.code.trim().length === 0) {
    return null;
  }

  const timeoutMs =
    typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)
      ? Math.max(1, Math.floor(record.timeoutMs))
      : undefined;

  const runId = typeof record.runId === "string" && record.runId.trim().length > 0
    ? record.runId.trim()
    : undefined;

  return {
    ...(runId ? { runId } : {}),
    code: record.code,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
};

const normalizeControlPlaneBaseUrl = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }

    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
};

const resolveControlPlaneBaseUrl = (request: Request): string | undefined => {
  const headerValue = request.headers.get(ExecutorControlPlaneBaseUrlHeader);
  if (headerValue) {
    const normalized = normalizeControlPlaneBaseUrl(headerValue);
    if (normalized) {
      return normalized;
    }
  }

  const url = new URL(request.url);
  return `${url.origin}`;
};

const resolveExecutionWorkspaceId = (
  request: Request,
  principal: ExecutorApiPrincipal,
  fallback?: string,
): string => {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId")?.trim();
  if (workspaceId && workspaceId.length > 0) {
    return workspaceId;
  }

  return fallback ?? principal.workspaceId;
};

export const createExecutorApiFetchHandler = (
  options: ExecutorApiFetchHandlerOptions,
): ((request: Request) => Promise<Response>) =>
  async (request: Request) => {
    const { pathname } = new URL(request.url);

    if (pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: options.healthServiceName ?? "executor-api",
      });
    }

    if (pathname === "/v1/openapi.json") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      return Response.json(controlPlaneOpenApiSpec);
    }

    if (pathname === "/v1/mcp") {
      if (
        request.method !== "GET"
        && request.method !== "POST"
        && request.method !== "DELETE"
      ) {
        return methodNotAllowed("GET, POST, DELETE");
      }

      const principalResult = await options.resolvePrincipal(request);
      if (principalResult instanceof Response) {
        return principalResult;
      }

      if (options.ensurePrincipal) {
        await options.ensurePrincipal(principalResult);
      }

      const requestWithPrincipal = applyPrincipalHeaders(request, principalResult);

      return options.handlers.handleMcp(
        requestWithPrincipal,
        resolveMcpWorkspaceId(
          request,
          principalResult,
          options.defaultMcpWorkspaceId,
        ),
      );
    }

    if (pathname === "/v1/mcp/admin") {
      if (
        request.method !== "GET"
        && request.method !== "POST"
        && request.method !== "DELETE"
      ) {
        return methodNotAllowed("GET, POST, DELETE");
      }

      if (!options.handlers.handleAdminMcp) {
        return notFound();
      }

      const principalResult = await options.resolvePrincipal(request);
      if (principalResult instanceof Response) {
        return principalResult;
      }

      if (options.ensurePrincipal) {
        await options.ensurePrincipal(principalResult);
      }

      const requestWithPrincipal = applyPrincipalHeaders(request, principalResult);

      return options.handlers.handleAdminMcp(
        requestWithPrincipal,
        resolveMcpWorkspaceId(
          request,
          principalResult,
          options.defaultMcpWorkspaceId,
        ),
      );
    }

    if (pathname === "/v1/runtime/tool-call") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST");
      }

      const principalResult = await options.resolvePrincipal(request);
      if (principalResult instanceof Response) {
        return principalResult;
      }

      if (options.ensurePrincipal) {
        await options.ensurePrincipal(principalResult);
      }

      return options.handlers.handleRuntimeToolCall(
        applyPrincipalHeaders(request, principalResult),
      );
    }

    if (pathname === "/v1/execute" || pathname === "/execute") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST");
      }

      const principalResult = await options.resolvePrincipal(request);
      if (principalResult instanceof Response) {
        return principalResult;
      }

      if (options.ensurePrincipal) {
        await options.ensurePrincipal(principalResult);
      }

      const input = await parseExecuteRequest(request);
      if (!input) {
        return Response.json(
          {
            ok: false,
            error: "Invalid execute request body. Expected { code: string, timeoutMs?: number }",
          },
          { status: 400 },
        );
      }

      const controlPlaneBaseUrl = resolveControlPlaneBaseUrl(request);

      const result = await options.handlers.executeRun(
        {
          ...input,
          ...(controlPlaneBaseUrl
            ? {
              context: {
                controlPlaneBaseUrl,
              },
            }
            : {}),
        },
        resolveExecutionWorkspaceId(request, principalResult, options.defaultMcpWorkspaceId),
      );

      return Response.json(result);
    }

    if (pathname.startsWith("/v1/") && isControlPlaneMethod(request.method)) {
      const principalResult = await options.resolvePrincipal(request);
      if (principalResult instanceof Response) {
        return principalResult;
      }

      if (options.ensurePrincipal) {
        await options.ensurePrincipal(principalResult);
      }

      return options.handlers.handleControlPlane(
        applyPrincipalHeaders(request, principalResult),
      );
    }

    return notFound();
  };
