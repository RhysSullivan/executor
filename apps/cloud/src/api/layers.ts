import { HttpApiBuilder, HttpMiddleware, HttpRouter, HttpServer } from "@effect/platform";
import { Effect, Layer } from "effect";

import { CoreExecutorApi } from "@executor/api";
import { CoreHandlers } from "@executor/api/server";
import { OpenApiGroup, OpenApiHandlers } from "@executor/plugin-openapi/api";
import { McpGroup, McpHandlers } from "@executor/plugin-mcp/api";
import {
  GoogleDiscoveryGroup,
  GoogleDiscoveryHandlers,
} from "@executor/plugin-google-discovery/api";
import { GraphqlGroup, GraphqlHandlers } from "@executor/plugin-graphql/api";

import { OrgAuth } from "../auth/middleware";
import { OrgAuthLive, SessionAuthLive } from "../auth/middleware-live";
import { UserStoreService } from "../auth/context";
import {
  CloudAuthPublicHandlers,
  CloudSessionAuthHandlers,
  NonProtectedApi,
} from "../auth/handlers";
import { WorkOSAuth } from "../auth/workos";
import { AutumnService } from "../services/autumn";
import { DbService } from "../services/db";
import { OrgHttpApi } from "../org/compose";
import { OrgHandlers } from "../org/handlers";

const ProtectedCloudApi = CoreExecutorApi.add(OpenApiGroup)
  .add(McpGroup)
  .add(GoogleDiscoveryGroup)
  .add(GraphqlGroup)
  .middleware(OrgAuth);

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));

export const SharedServices = Layer.mergeAll(
  DbLive,
  UserStoreLive,
  WorkOSAuth.Default,
  AutumnService.Default,
  HttpServer.layerContext,
);

export const RouterConfig = HttpRouter.setRouterConfig({ maxParamLength: 1000 });

export const ProtectedCloudApiLive = HttpApiBuilder.api(ProtectedCloudApi).pipe(
  Layer.provide(
    Layer.mergeAll(
      CoreHandlers,
      OpenApiHandlers,
      McpHandlers,
      GoogleDiscoveryHandlers,
      GraphqlHandlers,
      OrgAuthLive,
    ),
  ),
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
