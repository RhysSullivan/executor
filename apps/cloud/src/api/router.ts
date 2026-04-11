import { HttpApp, HttpRouter } from "@effect/platform";
import { Effect } from "effect";

export class TeamRequestHandlerService extends Effect.Service<TeamRequestHandlerService>()(
  "@executor/cloud/TeamRequestHandlerService",
  {
    sync: () => ({
      handle: async (request: Request) => {
        const { handleTeamRequest } = await import("./layers");
        return handleTeamRequest(request);
      },
    }),
  },
) {}

export class NonProtectedRequestHandlerService extends Effect.Service<NonProtectedRequestHandlerService>()(
  "@executor/cloud/NonProtectedRequestHandlerService",
  {
    sync: () => ({
      handle: async (request: Request) => {
        const { handleNonProtectedRequest } = await import("./layers");
        return handleNonProtectedRequest(request);
      },
    }),
  },
) {}

export class AutumnRequestHandlerService extends Effect.Service<AutumnRequestHandlerService>()(
  "@executor/cloud/AutumnRequestHandlerService",
  {
    sync: () => ({
      handle: async (request: Request) => {
        const { handleAutumnRequest } = await import("./autumn");
        return handleAutumnRequest(request);
      },
    }),
  },
) {}

export class ProtectedRequestHandlerService extends Effect.Service<ProtectedRequestHandlerService>()(
  "@executor/cloud/ProtectedRequestHandlerService",
  {
    sync: () => ({
      handle: async (request: Request): Promise<Response> => {
        const { handleProtectedRequest } = await import("./protected");
        return handleProtectedRequest(request);
      },
    }),
  },
) {}

export const ApiRouterApp = Effect.gen(function* () {
  const team = yield* TeamRequestHandlerService;
  const nonProtected = yield* NonProtectedRequestHandlerService;
  const autumn = yield* AutumnRequestHandlerService;
  const protectedHandler = yield* ProtectedRequestHandlerService;

  const teamApp = HttpApp.fromWebHandler(team.handle);
  const authApp = HttpApp.fromWebHandler(nonProtected.handle);
  const autumnApp = HttpApp.fromWebHandler(autumn.handle);
  const protectedApp = HttpApp.fromWebHandler(protectedHandler.handle);

  return yield* HttpRouter.empty.pipe(
    HttpRouter.mountApp("/team", teamApp),
    HttpRouter.mountApp("/auth", authApp),
    HttpRouter.mountApp("/autumn", autumnApp),
    HttpRouter.mountApp("/", protectedApp),
    HttpRouter.toHttpApp,
  );
});

export const ApiRequestHandler = Effect.map(ApiRouterApp, HttpApp.toWebHandler);
