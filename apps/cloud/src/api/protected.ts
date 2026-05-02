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
  providePluginExtensions,
} from "@executor-js/api/server";
// Type-only imports — needed in the `provides` clause so the framework
// knows which Service tags this middleware satisfies. Runtime binding
// is data-driven via `providePluginExtensions(cloudPlugins)`.
import type { OpenApiExtensionService } from "@executor-js/plugin-openapi/api";
import type { McpExtensionService } from "@executor-js/plugin-mcp/api";
import type { GraphqlExtensionService } from "@executor-js/plugin-graphql/api";

import executorConfig from "../../executor.config";
import { AuthContext } from "../auth/middleware";
import { authorizeOrganization } from "../auth/authorize-organization";
import { UserStoreService } from "../auth/context";
import { WorkOSAuth } from "../auth/workos";
import { AutumnService } from "../services/autumn";
import { DbService } from "../services/db";
import { makeExecutionStack } from "../services/execution-stack";
import { HttpResponseError } from "./error-response";
import { RequestScopedServicesLive } from "./layers";
import {
  ProtectedCloudApi,
  ProtectedCloudApiLive,
  RouterConfig,
} from "./protected-layers";
import { requestScopedMiddleware } from "./request-scoped";

// Plugin list at module-eval time — same property as
// `protected-layers.ts`: `plugins({})` is safe because no plugin's
// extension construction runs here.
const cloudPlugins = executorConfig.plugins({});

// Pre-compute the per-plugin `Effect.provideService(extensionService,
// executor[id])` chain. The plugin spec carries the Service tag so
// this file doesn't import each plugin's `*/api` directly.
const provideExecutorExtensions = providePluginExtensions(cloudPlugins);

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
//
// `DbService` and `UserStoreService` are pulled from per-request context
// — `RequestScopedServicesMiddleware` (combined below) provides them
// fresh per request so the postgres.js socket lives in the request
// fiber's scope, not the worker's boot scope.
const ExecutionStackMiddleware = HttpRouter.middleware<{
  // Listed for layer-level satisfaction. Runtime binding is data-driven
  // via `providePluginExtensions(cloudPlugins)(executor)` below — no
  // per-plugin `*ExtensionService` value imports needed.
  provides:
    | AuthContext
    | ExecutorService
    | ExecutionEngineService
    | OpenApiExtensionService
    | McpExtensionService
    | GraphqlExtensionService;
}>()(
  Effect.gen(function* () {
    const longLived = yield* Effect.context<WorkOSAuth | AutumnService>();
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
          provideExecutorExtensions(executor),
        );
      }).pipe(Effect.provideContext(longLived));
  }),
);

// `rsLive` is the per-request DB layer. Combining it into the auth
// middleware collapses `requires: DbService | UserStoreService` to
// never (so `.layer` is a real Layer instead of the "Need to combine"
// type-error sentinel) AND makes the postgres.js socket request-scoped:
// the layer rebuilds per HTTP request, satisfying Cloudflare Workers'
// I/O isolation. Exposed as a factory so tests can swap in a counting
// fake — see `apps/cloud/src/api.request-scope.node.test.ts`.
export const makeProtectedApiLive = (
  rsLive: Layer.Layer<DbService | UserStoreService>,
) => {
  const protectedMiddleware = ExecutionStackMiddleware.combine(
    requestScopedMiddleware(rsLive),
  ).layer;
  return ProtectedCloudApiLive.pipe(
    Layer.provide(protectedMiddleware),
    Layer.provideMerge(HttpApiSwagger.layer(ProtectedCloudApi, { path: "/docs" })),
    Layer.provideMerge(RouterConfig),
  );
};

export const ProtectedApiLive = makeProtectedApiLive(RequestScopedServicesLive);
