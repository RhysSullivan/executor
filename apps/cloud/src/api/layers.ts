import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform";
import { Effect, Layer } from "effect";

import { RouterConfig } from "./protected-layers";
export { ProtectedCloudApiLive, RouterConfig } from "./protected-layers";

import { OrgAuthLive, SessionAuthLive } from "../auth/middleware-live";
import { UserStoreService } from "../auth/context";
import {
  CloudAuthPublicHandlers,
  CloudSessionAuthHandlers,
  NonProtectedApi,
} from "../auth/handlers";
import { DbService } from "../services/db";
import { TelemetryLive } from "../services/telemetry";
import { OrgHttpApi } from "../org/compose";
import { OrgHandlers } from "../org/handlers";
import { CoreSharedServices } from "./core-shared-services";

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));

export const SharedServices = Layer.mergeAll(
  DbLive,
  UserStoreLive,
  CoreSharedServices,
  HttpServer.layerContext,
  TelemetryLive,
);

const NonProtectedApiLive = HttpApiBuilder.api(NonProtectedApi).pipe(
  Layer.provide(Layer.mergeAll(CloudAuthPublicHandlers, CloudSessionAuthHandlers)),
  Layer.provideMerge(SessionAuthLive),
);

const OrgApiLive = HttpApiBuilder.api(OrgHttpApi).pipe(
  Layer.provide(OrgHandlers),
  Layer.provideMerge(OrgAuthLive),
);

const NonProtectedRequestLayer = NonProtectedApiLive.pipe(
  Layer.provideMerge(RouterConfig),
  Layer.provideMerge(HttpServer.layerContext),
  Layer.provideMerge(HttpApiBuilder.Router.Live),
  Layer.provideMerge(HttpApiBuilder.Middleware.layer),
);

const OrgRequestLayer = OrgApiLive.pipe(
  Layer.provideMerge(RouterConfig),
  Layer.provideMerge(HttpServer.layerContext),
  Layer.provideMerge(HttpApiBuilder.Router.Live),
  Layer.provideMerge(HttpApiBuilder.Middleware.layer),
);

export const NonProtectedApiApp = Effect.flatMap(
  HttpApiBuilder.httpApp.pipe(Effect.provide(NonProtectedRequestLayer)),
  HttpMiddleware.logger,
).pipe(Effect.provide(SharedServices));

export const OrgApiApp = Effect.flatMap(
  HttpApiBuilder.httpApp.pipe(Effect.provide(OrgRequestLayer)),
  HttpMiddleware.logger,
).pipe(Effect.provide(SharedServices));
