import { env } from "cloudflare:workers";
import { HttpApiBuilder, HttpApiSwagger, HttpServerRequest } from "@effect/platform";
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
import { HttpResponseError, isServerError, toErrorServerResponse } from "./error-response";
import { withExecutionUsageTracking } from "./execution-usage";
import { ProtectedCloudApiLive, RouterConfig, SharedServices } from "./layers";

const lookupOrgForRequest = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const webRequest = yield* Effect.mapError(
      HttpServerRequest.toWeb(request),
      () =>
        new HttpResponseError({
          status: 500,
          code: "invalid_request",
          message: "Invalid request",
        }),
    );
    const workos = yield* WorkOSAuth;
    const session = yield* workos.authenticateRequest(webRequest);
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
          Layer.provideMerge(RouterConfig),
          Layer.provideMerge(HttpApiBuilder.Router.Live),
          Layer.provideMerge(HttpApiBuilder.Middleware.layer),
        ),
      ),
    );
  });

const handleProtectedRequestEffect = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const org = yield* lookupOrgForRequest(request);
  if (!org) {
    return yield* Effect.fail(
      new HttpResponseError({
        status: 403,
        code: "no_organization",
        message: "No organization in session",
      }),
    );
  }

  const app = yield* createProtectedApp(org.id, org.name);
  return yield* app;
}).pipe(
  Effect.provide(SharedServices),
  Effect.catchAll((err) => {
    if (isServerError(err)) {
      console.error("[api] request failed:", err instanceof Error ? err.stack : err);
    }
    return Effect.succeed(toErrorServerResponse(err));
  }),
);

export const ProtectedApiApp = handleProtectedRequestEffect;
