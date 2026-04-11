import { HttpApp, HttpRouter } from "@effect/platform";
import { Context, Effect } from "effect";

type RequestAppService = {
  readonly app: HttpApp.Default;
};

export class OrgRequestHandlerService extends Context.Tag(
  "@executor/cloud/OrgRequestHandlerService",
)<OrgRequestHandlerService, RequestAppService>() {}

export class NonProtectedRequestHandlerService extends Context.Tag(
  "@executor/cloud/NonProtectedRequestHandlerService",
)<NonProtectedRequestHandlerService, RequestAppService>() {}

export class AutumnRequestHandlerService extends Context.Tag(
  "@executor/cloud/AutumnRequestHandlerService",
)<AutumnRequestHandlerService, RequestAppService>() {}

export class ProtectedRequestHandlerService extends Context.Tag(
  "@executor/cloud/ProtectedRequestHandlerService",
)<ProtectedRequestHandlerService, RequestAppService>() {}

export const ApiRouterApp = Effect.gen(function* () {
  const org = yield* OrgRequestHandlerService;
  const nonProtected = yield* NonProtectedRequestHandlerService;
  const autumn = yield* AutumnRequestHandlerService;
  const protectedHandler = yield* ProtectedRequestHandlerService;

  return yield* HttpRouter.empty.pipe(
    HttpRouter.mountApp("/org", org.app, { includePrefix: true }),
    HttpRouter.mountApp("/auth", nonProtected.app, { includePrefix: true }),
    HttpRouter.mountApp("/autumn", autumn.app, { includePrefix: true }),
    HttpRouter.mountApp("/", protectedHandler.app),
    HttpRouter.toHttpApp,
  );
});

export const ApiRequestHandler = Effect.map(ApiRouterApp, HttpApp.toWebHandler);
