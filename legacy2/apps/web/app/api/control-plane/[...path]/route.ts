import { withAuth } from "@workos-inc/authkit-nextjs";
import type { NextRequest } from "next/server";

import {
  ExecutorControlPlaneBaseUrlHeader,
  createExecutorApiFetchHandler,
  type ExecutorApiPrincipal,
} from "@executor-v2/api-http";
import {
  createLocalPrincipal,
  createWorkosPrincipal,
  getControlPlaneRuntime,
  provisionPrincipal,
} from "../../../../lib/control-plane/server";
import {
  getMcpAuthConfig,
  verifyMcpBearerToken,
} from "../../../../lib/mcp/resource-auth";
import { isWorkosEnabled } from "../../../../lib/workos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    path?: Array<string>;
  }>;
};

const isCsrfSafeMethod = (method: string): boolean =>
  method === "GET" || method === "HEAD" || method === "OPTIONS";

const rewriteControlPlaneRequest = (
  request: NextRequest,
  path: ReadonlyArray<string>,
): Request => {
  const rewrittenUrl = new URL(request.url);
  rewrittenUrl.pathname = `/${path.join("/")}`;
  const rewrittenRequest = new Request(rewrittenUrl, request);
  const headers = new Headers(request.headers);
  headers.set(
    ExecutorControlPlaneBaseUrlHeader,
    `${request.nextUrl.origin}/api/control-plane`,
  );
  return new Request(rewrittenRequest, { headers });
};

const storageErrorResponse = (operation: string, cause: unknown): Response => {
  const details = cause instanceof Error ? cause.message : String(cause);

  return Response.json(
    {
      _tag: "ControlPlaneStorageError",
      operation,
      message: "Control plane operation failed",
      details,
    },
    { status: 500 },
  );
};

const unauthorizedResponse = (operation: string, details: string): Response =>
  Response.json(
    {
      _tag: "ControlPlaneUnauthorizedError",
      operation,
      message: "Unauthorized",
      details,
    },
    { status: 401 },
  );

const forbiddenResponse = (operation: string, details: string): Response =>
  Response.json(
    {
      _tag: "ControlPlaneForbiddenError",
      operation,
      message: "Forbidden",
      details,
    },
    { status: 403 },
  );

const handle = async (request: NextRequest, context: RouteContext): Promise<Response> => {
  try {
    const method = request.method.toUpperCase();
    const { path = [] } = await context.params;

    if (
      path.length === 0
      || (path[0] !== "v1" && !(path.length === 1 && path[0] === "execute"))
    ) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (!isCsrfSafeMethod(method)) {
      const origin = request.headers.get("origin");
      if (origin && origin !== request.nextUrl.origin) {
        return forbiddenResponse("control-plane.request", "Invalid origin");
      }
    }

    const runtime = await getControlPlaneRuntime();
    const controlPlaneRequest = rewriteControlPlaneRequest(request, path);

    let principal: ReturnType<typeof createLocalPrincipal>;

    if (!isWorkosEnabled()) {
      principal = createLocalPrincipal();
    } else {
      const bearerPrincipal = await verifyMcpBearerToken(
        controlPlaneRequest,
        getMcpAuthConfig(),
      );
      if (bearerPrincipal) {
        principal = createWorkosPrincipal({
          subject: bearerPrincipal.subject,
          email: bearerPrincipal.email,
          displayName: bearerPrincipal.displayName,
        });
      }

      if (!bearerPrincipal) {
        let user:
          | {
              id: string;
              email?: string | null;
              firstName?: string | null;
              lastName?: string | null;
            }
          | null
          | undefined;

        try {
          ({ user } = await withAuth());
        } catch {
          return unauthorizedResponse("control-plane.auth", "Authentication unavailable");
        }

        if (!user) {
          return unauthorizedResponse("control-plane.auth", "Unauthorized");
        }

        const displayName = [user.firstName, user.lastName]
          .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
          .join(" ")
          || null;

        principal = createWorkosPrincipal({
          subject: user.id,
          email: user.email ?? null,
          displayName,
        });
      }
    }

    const fetchHandler = createExecutorApiFetchHandler({
      handlers: {
        handleControlPlane: runtime.handleControlPlane,
        handleMcp: runtime.handleMcp,
        handleAdminMcp: runtime.handleAdminMcp,
        handleRuntimeToolCall: runtime.handleRuntimeToolCall,
        executeRun: runtime.executeRun,
      },
      resolvePrincipal: async () => principal as ExecutorApiPrincipal,
      ensurePrincipal: (nextPrincipal) => provisionPrincipal(runtime, nextPrincipal as any),
      healthServiceName: "executor-web-control-plane",
    });

    return fetchHandler(controlPlaneRequest);
  } catch (cause) {
    console.error("[control-plane] request failed", {
      method: request.method,
      path: request.nextUrl.pathname,
      cause,
    });
    return storageErrorResponse("control-plane.request", cause);
  }
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
