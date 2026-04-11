import { Effect } from "effect";
import {
  ApiRequestHandler,
  AutumnRequestHandlerService,
  NonProtectedRequestHandlerService,
  ProtectedRequestHandlerService,
  TeamRequestHandlerService,
} from "./api/router";

export const handleApiRequest = Effect.runSync(
  Effect.provide(ApiRequestHandler, [
    TeamRequestHandlerService.Default,
    NonProtectedRequestHandlerService.Default,
    AutumnRequestHandlerService.Default,
    ProtectedRequestHandlerService.Default,
  ]),
);
