// ---------------------------------------------------------------------------
// Cloud API — non-protected (auth) endpoints + org-protected executor endpoints
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import { Autumn } from "autumn-js";
import { autumnHandler } from "autumn-js/backend";

import { CoreExecutorApi } from "@executor/api";
import { CoreHandlers, ExecutorService, ExecutionEngineService } from "@executor/api/server";
import { createExecutionEngine } from "@executor/execution";
import { makeDynamicWorkerExecutor, type CodeExecutor } from "@executor/runtime-dynamic-worker";
import {
  OpenApiGroup,
  OpenApiExtensionService,
  OpenApiHandlers,
} from "@executor/plugin-openapi/api";
import { McpGroup, McpExtensionService, McpHandlers } from "@executor/plugin-mcp/api";
import {
  GoogleDiscoveryGroup,
  GoogleDiscoveryExtensionService,
  GoogleDiscoveryHandlers,
} from "@executor/plugin-google-discovery/api";
import {
  GraphqlGroup,
  GraphqlExtensionService,
  GraphqlHandlers,
} from "@executor/plugin-graphql/api";

import { OrgAuth } from "./auth/middleware";
import { OrgAuthLive, SessionAuthLive } from "./auth/middleware-live";
import { UserStoreService } from "./auth/context";
import {
  CloudAuthPublicHandlers,
  CloudSessionAuthHandlers,
  NonProtectedApi,
} from "./auth/handlers";
import { WorkOSAuth } from "./auth/workos";
import { DbService } from "./services/db";
import { createOrgExecutor } from "./services/executor";
import { server } from "./env";

// ---------------------------------------------------------------------------
// API definitions
// ---------------------------------------------------------------------------

/** Protected (org-required) API — all the executor groups + OrgAuth middleware */
const ProtectedCloudApi = CoreExecutorApi.add(OpenApiGroup)
  .add(McpGroup)
  .add(GoogleDiscoveryGroup)
  .add(GraphqlGroup)
  .middleware(OrgAuth);

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));

const SharedServices = Layer.mergeAll(
  DbLive,
  UserStoreLive,
  WorkOSAuth.Default,
  HttpServer.layerContext,
);
const ProtectedCloudApiLive = HttpApiBuilder.api(ProtectedCloudApi).pipe(
  Layer.provide(
    Layer.mergeAll(
      CoreHandlers,
      OpenApiHandlers,
      McpHandlers,
      GoogleDiscoveryHandlers,
      GraphqlHandlers,
      OrgAuthLive,
    ),
  ),
);

const NonProtectedApiLive = HttpApiBuilder.api(NonProtectedApi).pipe(
  Layer.provide(Layer.mergeAll(CloudAuthPublicHandlers, CloudSessionAuthHandlers)),
  Layer.provideMerge(SessionAuthLive),
);

// ---------------------------------------------------------------------------
// Public auth web handler
// ---------------------------------------------------------------------------
//
// Build per-request, not once at module load. `toWebHandler` creates a
// single long-lived `Layer.MemoMap` that memoizes `DbService.Live`'s
// `Layer.scoped` acquire — the resulting `sql` connection is created in
// the module scope, not the request scope. Workerd tears down TCP sockets
// at request boundaries, so the second request on a cached handler fails
// with "Cannot perform I/O on behalf of a different request". Building a
// fresh handler per request gives each request its own layer scope and a
// fresh socket. Auth endpoints (login/callback/me/logout) are infrequent
// so the overhead is negligible.
// ---------------------------------------------------------------------------

const RouterConfig = HttpRouter.setRouterConfig({ maxParamLength: 1000 });

const createNonProtectedHandler = () =>
  HttpApiBuilder.toWebHandler(
    NonProtectedApiLive.pipe(Layer.provideMerge(SharedServices), Layer.provideMerge(RouterConfig)),
    { middleware: HttpMiddleware.logger },
  );

// ---------------------------------------------------------------------------
// Protected handler — must be built per-request because the executor varies
// ---------------------------------------------------------------------------

const buildProtectedHandler = (
  organizationId: string,
  organizationName: string,
  codeExecutor: CodeExecutor,
) =>
  Effect.gen(function* () {
    const executor = yield* createOrgExecutor(
      organizationId,
      organizationName,
      server.ENCRYPTION_KEY,
    );

    const engine = createExecutionEngine({ executor, codeExecutor });

    const requestServices = Layer.mergeAll(
      Layer.succeed(ExecutorService, executor),
      Layer.succeed(ExecutionEngineService, engine),
      Layer.succeed(OpenApiExtensionService, executor.openapi),
      Layer.succeed(McpExtensionService, executor.mcp),
      Layer.succeed(GoogleDiscoveryExtensionService, executor.googleDiscovery),
      Layer.succeed(GraphqlExtensionService, executor.graphql),
    );

    return HttpApiBuilder.toWebHandler(
      HttpApiSwagger.layer({ path: "/docs" }).pipe(
        Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
        Layer.provideMerge(ProtectedCloudApiLive),
        Layer.provideMerge(requestServices),
        Layer.provideMerge(SharedServices),
        Layer.provideMerge(HttpRouter.setRouterConfig({ maxParamLength: 1000 })),
      ),
      { middleware: HttpMiddleware.logger },
    );
  });

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const isAuthPath = (pathname: string): boolean => pathname.startsWith("/auth/");
const isAutumnPath = (pathname: string): boolean => pathname.startsWith("/autumn/");
const isExecutionPath = (pathname: string): boolean =>
  pathname === "/executions" || /^\/executions\/[^/]+\/resume$/.test(pathname);

// ---------------------------------------------------------------------------
// Autumn billing — lazy-initialized SDK for fire-and-forget tracking
// ---------------------------------------------------------------------------

let _autumn: Autumn | null = null;
const getAutumn = () => {
  if (!_autumn && server.AUTUMN_SECRET_KEY) {
    _autumn = new Autumn({ secretKey: server.AUTUMN_SECRET_KEY });
  }
  return _autumn;
};

/**
 * Resolve the user's organization for executor creation. Reads from the
 * session cookie via WorkOS — returns null if there's no session or no
 * organization yet, so the caller can return a 403.
 */
const lookupOrgForRequest = (request: Request) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    const result = yield* workos.authenticateRequest(request);
    if (!result || !result.organizationId) return null;
    const users = yield* UserStoreService;
    return yield* users.use((s) => s.getOrganization(result.organizationId!));
  });

// ---------------------------------------------------------------------------
// Autumn billing proxy — authenticates the session, then forwards to Autumn
// ---------------------------------------------------------------------------

const handleAutumnRequest = async (request: Request): Promise<Response> => {
  const program = Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    const result = yield* workos.authenticateRequest(request);

    if (!result || !result.organizationId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const body =
      request.method !== "GET" && request.method !== "HEAD"
        ? yield* Effect.promise(() => request.json())
        : undefined;

    const { statusCode, response } = yield* Effect.promise(() =>
      autumnHandler({
        request: {
          url: url.pathname,
          method: request.method,
          body,
        },
        customerId: result.organizationId,
        customerData: {
          name: result.email,
          email: result.email,
        },
        clientOptions: {
          secretKey: server.AUTUMN_SECRET_KEY,
        },
        pathPrefix: "/autumn",
      }),
    );

    if (statusCode >= 400) {
      console.error("[autumn] upstream error:", statusCode, response);
      return Response.json({ error: "Billing request failed" }, { status: statusCode });
    }

    return Response.json(response, { status: statusCode });
  });

  return Effect.runPromise(program.pipe(Effect.provide(SharedServices), Effect.scoped)).catch(
    (err) => {
      console.error("[autumn] request failed:", err instanceof Error ? err.stack : err);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    },
  );
};

export const handleApiRequest = async (request: Request): Promise<Response> => {
  const pathname = new URL(request.url).pathname;

  if (isAutumnPath(pathname)) {
    return handleAutumnRequest(request);
  }

  if (isAuthPath(pathname)) {
    const handler = createNonProtectedHandler();
    try {
      return await handler.handler(request);
    } finally {
      await handler.dispose();
    }
  }

  // Protected path — build the executor lazily for the request's org.
  try {
    const program = Effect.gen(function* () {
      const org = yield* lookupOrgForRequest(request);
      if (!org) return null;

      const codeExecutor = makeDynamicWorkerExecutor({ loader: env.LOADER });
      const handler = yield* buildProtectedHandler(org.id, org.name, codeExecutor);
      const response = yield* Effect.promise(() => handler.handler(request));
      return { response, orgId: org.id };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(SharedServices), Effect.scoped),
    );

    if (result === null) {
      return Response.json(
        { error: "No organization in session", code: "no_organization" },
        { status: 403 },
      );
    }

    // Fire-and-forget: track execution usage
    if (isExecutionPath(pathname) && result.response.ok) {
      const autumn = getAutumn();
      if (autumn) {
        autumn
          .track({
            customerId: result.orgId,
            featureId: "executions",
            value: 1,
          })
          .catch((err) => {
            console.error("[billing] track failed:", err);
          });
      }
    }

    return result.response;
  } catch (err) {
    console.error("[api] request failed:", err instanceof Error ? err.stack : err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
};
