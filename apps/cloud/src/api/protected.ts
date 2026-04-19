import { HttpApiBuilder, HttpApiSwagger, HttpServerRequest } from "@effect/platform";
import { Effect, Layer } from "effect";

import { ExecutorService, ExecutionEngineService } from "@executor/api/server";
import { OpenApiExtensionService } from "@executor/plugin-openapi/api";
import { McpExtensionService } from "@executor/plugin-mcp/api";
import { GraphqlExtensionService } from "@executor/plugin-graphql/api";

import { authorizeOrganization } from "../auth/authorize-organization";
import { deriveUserScopeId } from "../auth/middleware-live";
import { WorkOSAuth } from "../auth/workos";
import { makeExecutionStack } from "../services/execution-stack";
import { HttpResponseError, isServerError, toErrorServerResponse } from "./error-response";
import { ProtectedCloudApiLive, RouterConfig, SharedServices } from "./layers";

// `/scopes/<scopeId>/...` — the URL's scope segment selects the write
// target for the request. Anything outside that pattern (unscoped
// routes) uses the default write target (innermost = user scope).
const SCOPE_PATH_REGEX = /\/scopes\/([^/]+)/;
const extractUrlScopeId = (url: string): string | null => {
  try {
    const pathname = new URL(url, "http://x").pathname;
    const match = pathname.match(SCOPE_PATH_REGEX);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
};

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
    return org ? { ...org, userId: session.userId, userName: session.firstName ?? null } : null;
  });

interface ProtectedAppOptions {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly userScopeId: string;
  readonly userName: string;
  readonly writeScopeId: string;
}

const createProtectedApp = (options: ProtectedAppOptions) =>
  Effect.gen(function* () {
    const { executor, engine } = yield* makeExecutionStack({
      organizationId: options.organizationId,
      read: [
        { id: options.userScopeId, name: options.userName },
        { id: options.organizationId, name: options.organizationName },
      ],
      writeScopeId: options.writeScopeId,
    });

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

  const userScopeId = deriveUserScopeId(org.userId);
  const urlScopeId = extractUrlScopeId(request.url);
  // Only accept an explicit write-target when the URL names a scope
  // the caller actually has in their read chain. Anything else would
  // be a cross-tenant write.
  const writeScopeId =
    urlScopeId === org.id || urlScopeId === userScopeId
      ? urlScopeId
      : userScopeId;
  const app = yield* createProtectedApp({
    organizationId: org.id,
    organizationName: org.name,
    userScopeId,
    userName: org.userName ?? org.userId,
    writeScopeId,
  });
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
