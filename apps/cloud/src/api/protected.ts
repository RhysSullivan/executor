import { HttpApiBuilder, HttpApiSwagger, HttpServerRequest } from "@effect/platform";
import { Effect, Layer } from "effect";

import { ExecutorService, ExecutionEngineService } from "@executor/api/server";
import { OpenApiExtensionService } from "@executor/plugin-openapi/api";
import { McpExtensionService } from "@executor/plugin-mcp/api";
import { GraphqlExtensionService } from "@executor/plugin-graphql/api";

import { authorizeOrganization } from "../auth/authorize-organization";
import { WorkOSAuth } from "../auth/workos";
import { makeExecutionStack } from "../services/execution-stack";
import { HttpResponseError, isServerError, toErrorServerResponse } from "./error-response";
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

    const org = yield* authorizeOrganization(session.userId, session.organizationId);
    if (!org) return null;
    return { org, userId: session.userId };
  });

const createProtectedApp = (userId: string, organizationId: string, organizationName: string) =>
  Effect.gen(function* () {
    const { executor, engine } = yield* makeExecutionStack(
      userId,
      organizationId,
      organizationName,
    );

    const requestServices = Layer.mergeAll(
      Layer.succeed(ExecutorService, executor),
      Layer.succeed(ExecutionEngineService, engine),
      Layer.succeed(OpenApiExtensionService, executor.openapi),
      Layer.succeed(McpExtensionService, executor.mcp),
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

export const ProtectedApiApp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* lookupOrgForRequest(request);
  if (!session) {
    return yield* Effect.fail(
      new HttpResponseError({
        status: 403,
        code: "no_organization",
        message: "No organization in session",
      }),
    );
  }

  const app = yield* createProtectedApp(session.userId, session.org.id, session.org.name);
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
