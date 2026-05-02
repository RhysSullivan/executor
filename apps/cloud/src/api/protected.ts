// Production wiring for the protected API. Lives outside `protected-layers.ts`
// because `makeExecutionStack` imports `cloudflare:workers`, which the test
// harness can't load in the workerd test runtime.

import { HttpApiSwagger } from "effect/unstable/httpapi";
import {
  HttpRouter,
  HttpServerRequest,
} from "effect/unstable/http";
import { Effect, Layer } from "effect";

import {
  ExecutionEngineService,
  ExecutorService,
} from "@executor-js/api/server";
import { OpenApiExtensionService } from "@executor-js/plugin-openapi/api";
import { McpExtensionService } from "@executor-js/plugin-mcp/api";
import { GraphqlExtensionService } from "@executor-js/plugin-graphql/api";

import { AuthContext } from "../auth/middleware";
import { authorizeOrganization } from "../auth/authorize-organization";
import { UserStoreService } from "../auth/context";
import { WorkOSAuth } from "../auth/workos";
import { AutumnService } from "../services/autumn";
import { DbService } from "../services/db";
import { makeExecutionStack } from "../services/execution-stack";
import { HttpResponseError } from "./error-response";
import {
  ProtectedCloudApi,
  ProtectedCloudApiLive,
  RouterConfig,
} from "./protected-layers";

// One `HttpRouter` middleware that:
//   1. authenticates the WorkOS sealed session,
//   2. verifies live org membership (closes the JWT-cache gap — see
//      `auth/authorize-organization.ts`),
//   3. resolves the org name,
//   4. builds the per-request executor + engine,
//   5. provides `AuthContext` + the execution-stack services to the handler.
//
// Replaces both the old outer `Effect.gen` in this file (which did its own
// WorkOS lookup) and the per-route `OrgAuth` HttpApiMiddleware (which did
// a second one).
//
// Errors are NOT caught here: failures propagate as typed errors and are
// rendered to a JSON response by the framework's `Respondable` pipeline
// (see `HttpResponseError` in `./error-response.ts`). Letting `unhandled`
// pass through is what satisfies `HttpRouter.middleware`'s brand check
// without any type casts.
const ExecutionStackMiddleware = HttpRouter.middleware<{
  provides:
    | AuthContext
    | ExecutorService
    | ExecutionEngineService
    | OpenApiExtensionService
    | McpExtensionService
    | GraphqlExtensionService;
}>()(
  // Layer-time setup — capture the long-lived services in a closure so
  // the per-request function only needs `HttpRouter`-Provided context.
  // That collapses the middleware's `requires` to `never`, giving us a
  // real `.layer` (instead of the "Need to .combine(...)" type-error
  // sentinel that fires when `requires` leaks to non-never).
  Effect.gen(function* () {
    const context = yield* Effect.context<
      WorkOSAuth | UserStoreService | AutumnService | DbService
    >();
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const workos = yield* WorkOSAuth;
        const session = yield* workos.authenticateRequest(webRequest);
        if (!session || !session.organizationId) {
          return yield* new HttpResponseError({
            status: 403,
            code: "no_organization",
            message: "No organization in session",
          });
        }
        const org = yield* authorizeOrganization(session.userId, session.organizationId);
        if (!org) {
          return yield* new HttpResponseError({
            status: 403,
            code: "no_organization",
            message: "No organization in session",
          });
        }
        const auth = AuthContext.of({
          accountId: session.userId,
          organizationId: org.id,
          email: session.email,
          name: `${session.firstName ?? ""} ${session.lastName ?? ""}`.trim() || null,
          avatarUrl: session.avatarUrl ?? null,
        });
        const { executor, engine } = yield* makeExecutionStack(auth.accountId, org.id, org.name);
        return yield* httpEffect.pipe(
          Effect.provideService(AuthContext, auth),
          Effect.provideService(ExecutorService, executor),
          Effect.provideService(ExecutionEngineService, engine),
          Effect.provideService(OpenApiExtensionService, executor.openapi),
          Effect.provideService(McpExtensionService, executor.mcp),
          Effect.provideService(GraphqlExtensionService, executor.graphql),
        );
      }).pipe(Effect.provideContext(context));
  }),
).layer;

export const ProtectedApiLive = ProtectedCloudApiLive.pipe(
  Layer.provide(ExecutionStackMiddleware),
  Layer.provideMerge(HttpApiSwagger.layer(ProtectedCloudApi, { path: "/docs" })),
  Layer.provideMerge(RouterConfig),
);
