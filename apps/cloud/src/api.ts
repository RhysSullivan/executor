import { Effect, Layer } from "effect";
import { AutumnApiApp } from "./api/autumn";
import { NonProtectedApiApp, TeamApiApp } from "./api/layers";
import { ProtectedApiApp } from "./api/protected";
import {
  ApiRequestHandler,
  AutumnRequestHandlerService,
  NonProtectedRequestHandlerService,
  ProtectedRequestHandlerService,
  TeamRequestHandlerService,
} from "./api/router";

const ApiRequestHandlersLive = Layer.mergeAll(
  Layer.succeed(TeamRequestHandlerService, { app: TeamApiApp }),
  Layer.succeed(NonProtectedRequestHandlerService, { app: NonProtectedApiApp }),
  Layer.succeed(AutumnRequestHandlerService, { app: AutumnApiApp }),
  Layer.succeed(ProtectedRequestHandlerService, { app: ProtectedApiApp }),
);

export const handleApiRequest = Effect.runSync(
  Effect.provide(ApiRequestHandler, ApiRequestHandlersLive),
);
