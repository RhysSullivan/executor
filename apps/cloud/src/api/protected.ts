import { env } from "cloudflare:workers";
import { HttpApiBuilder, HttpApiSwagger, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Layer } from "effect";

import { ExecutorService, ExecutionEngineService } from "@executor/api/server";
import { createExecutionEngine } from "@executor/execution";
import { makeDynamicWorkerExecutor } from "@executor/runtime-dynamic-worker";
import { OpenApiExtensionService } from "@executor/plugin-openapi/api";
import { McpExtensionService } from "@executor/plugin-mcp/api";
import { GoogleDiscoveryExtensionService } from "@executor/plugin-google-discovery/api";
import { GraphqlExtensionService } from "@executor/plugin-graphql/api";

import { UserStoreService } from "../auth/context";
import { WorkOSAuth } from "../auth/workos";
import { server } from "../env";
import { createOrgExecutor } from "../services/executor";
import { trackExecutionUsage } from "./autumn";
import { withExecutionUsageTracking } from "./execution-usage";
import { ProtectedCloudApiLive, RouterConfig, SharedServices } from "./layers";

const lookupOrgForRequest = (request: Request) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    const session = yield* workos.authenticateRequest(request);
    if (!session || !session.organizationId) return null;

    const users = yield* UserStoreService;
    return yield* users.use((s) => s.getOrganization(session.organizationId!));
  });

const createProtectedApp = (organizationId: string, organizationName: string) =>
  Effect.gen(function* () {
    const executor = yield* createOrgExecutor(
      organizationId,
      organizationName,
      server.ENCRYPTION_KEY,
    );
    const codeExecutor = makeDynamicWorkerExecutor({ loader: env.LOADER });
    const engine = withExecutionUsageTracking(
      organizationId,
      createExecutionEngine({ executor, codeExecutor }),
      trackExecutionUsage,
    );

    const requestServices = Layer.mergeAll(
      Layer.succeed(ExecutorService, executor),
      Layer.succeed(ExecutionEngineService, engine),
      Layer.succeed(OpenApiExtensionService, executor.openapi),
      Layer.succeed(McpExtensionService, executor.mcp),
      Layer.succeed(GoogleDiscoveryExtensionService, executor.googleDiscovery),
      Layer.succeed(GraphqlExtensionService, executor.graphql),
    );

    return yield* HttpApiBuilder.httpApp.pipe(
      Effect.provide(
        HttpApiSwagger.layer({ path: "/docs" }).pipe(
          Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
          Layer.provideMerge(ProtectedCloudApiLive),
          Layer.provideMerge(requestServices),
          Layer.provideMerge(SharedServices),
          Layer.provideMerge(RouterConfig),
          Layer.provideMerge(HttpApiBuilder.Router.Live),
          Layer.provideMerge(HttpApiBuilder.Middleware.layer),
        ),
      ),
    );
  });

const handleProtectedRequestEffect = (request: Request) =>
  Effect.gen(function* () {
    const org = yield* lookupOrgForRequest(request);
    if (!org) {
      return Response.json(
        { error: "No organization in session", code: "no_organization" },
        { status: 403 },
      );
    }

    const app = yield* createProtectedApp(org.id, org.name);
    return yield* app.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
      Effect.map(HttpServerResponse.toWeb),
    );
  }).pipe(
    Effect.provide(SharedServices),
    Effect.scoped,
    Effect.catchAll((err) => {
      console.error("[api] request failed:", err instanceof Error ? err.stack : err);
      return Effect.succeed(Response.json({ error: "Internal server error" }, { status: 500 }));
    }),
  );

export const handleProtectedRequest = (request: Request): Promise<Response> =>
  Effect.runPromise(handleProtectedRequestEffect(request));
