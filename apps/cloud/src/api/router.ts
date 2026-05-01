import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Context, Effect, Scope } from "effect";

export type ApiRouteApp = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>;

type RequestAppService = {
  readonly app: ApiRouteApp;
};

export class OrgRequestHandlerService extends Context.Service<OrgRequestHandlerService, RequestAppService>()(
  "@executor-js/cloud/OrgRequestHandlerService",
) {}

export class NonProtectedRequestHandlerService extends Context.Service<NonProtectedRequestHandlerService, RequestAppService>()(
  "@executor-js/cloud/NonProtectedRequestHandlerService",
) {}

export class AutumnRequestHandlerService extends Context.Service<AutumnRequestHandlerService, RequestAppService>()(
  "@executor-js/cloud/AutumnRequestHandlerService",
) {}

export class ProtectedRequestHandlerService extends Context.Service<ProtectedRequestHandlerService, RequestAppService>()(
  "@executor-js/cloud/ProtectedRequestHandlerService",
) {}

export const ApiRouterApp = Effect.gen(function* () {
  const org = yield* OrgRequestHandlerService;
  const nonProtected = yield* NonProtectedRequestHandlerService;
  const autumn = yield* AutumnRequestHandlerService;
  const protectedHandler = yield* ProtectedRequestHandlerService;
  const asRouteApp = (app: ApiRouteApp) =>
    app.pipe(
      Effect.catchCause(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );

  const router = yield* HttpRouter.make;
  yield* router.add("*", "/org/*", asRouteApp(org.app));
  yield* router.add("*", "/auth/*", asRouteApp(nonProtected.app));
  yield* router.add("*", "/autumn/*", asRouteApp(autumn.app));
  yield* router.add("*", "*", asRouteApp(protectedHandler.app));

  return router.asHttpEffect();
});

export const ApiRequestHandler = ApiRouterApp;
