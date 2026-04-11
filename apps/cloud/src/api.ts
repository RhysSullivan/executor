import { Effect, Layer } from "effect";
import { AutumnApiApp } from "./api/autumn";
import { NonProtectedApiApp, OrgApiApp } from "./api/layers";
import { ProtectedApiApp } from "./api/protected";
import {
  ApiRequestHandler,
  AutumnRequestHandlerService,
  NonProtectedRequestHandlerService,
  ProtectedRequestHandlerService,
  OrgRequestHandlerService,
} from "./api/router";

const ApiRequestHandlersLive = Layer.mergeAll(
  Layer.succeed(OrgRequestHandlerService, { app: OrgApiApp }),
  Layer.succeed(NonProtectedRequestHandlerService, { app: NonProtectedApiApp }),
  Layer.succeed(AutumnRequestHandlerService, { app: AutumnApiApp }),
  Layer.succeed(ProtectedRequestHandlerService, { app: ProtectedApiApp }),
);

export const handleApiRequest = Effect.runSync(
  Effect.provide(ApiRequestHandler, ApiRequestHandlersLive),
);
