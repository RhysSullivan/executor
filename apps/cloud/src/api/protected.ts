import { HttpApiSwagger } from "effect/unstable/httpapi";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
} from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { ExecutorService, ExecutionEngineService } from "@executor-js/api/server";
import { OpenApiExtensionService } from "@executor-js/plugin-openapi/api";
import { McpExtensionService } from "@executor-js/plugin-mcp/api";
import { GraphqlExtensionService } from "@executor-js/plugin-graphql/api";

import { authorizeOrganization } from "../auth/authorize-organization";
import { WorkOSAuth } from "../auth/workos";
import { makeExecutionStack } from "../services/execution-stack";
import { HttpResponseError, isServerError, toErrorServerResponse } from "./error-response";
import { ProtectedCloudApi, ProtectedCloudApiLive, RouterConfig, SharedServices } from "./layers";

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

const createProtectedApp = (
  userId: string,
  organizationId: string,
  organizationName: string,
) =>
  Effect.gen(function* () {
    const { executor, engine } = yield* makeExecutionStack(
      userId,
      organizationId,
      organizationName,
    );

    const requestServices = Layer.mergeAll(
      Layer.succeed(ExecutorService)(executor),
      Layer.succeed(ExecutionEngineService)(engine),
      Layer.succeed(OpenApiExtensionService)(executor.openapi),
      Layer.succeed(McpExtensionService)(executor.mcp),
      Layer.succeed(GraphqlExtensionService)(executor.graphql),
    );

    const protectedApiLayer = ProtectedCloudApiLive.pipe(
      Layer.provideMerge(HttpApiSwagger.layer(ProtectedCloudApi, { path: "/docs" })),
      Layer.provideMerge(RouterConfig),
    );

    return yield* HttpRouter.toHttpEffect(protectedApiLayer).pipe(
      Effect.flatMap(HttpMiddleware.logger),
      Effect.provide(requestServices),
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

  return yield* createProtectedApp(session.userId, session.org.id, session.org.name);
}).pipe(
  Effect.provide(SharedServices),
  Effect.catchCause((err) => {
    if (isServerError(err)) {
      console.error("[api] request failed:", err instanceof Error ? err.stack : err);
    }
    return Effect.succeed(toErrorServerResponse(err));
  }),
);
