import { HttpApiBuilder, HttpMiddleware, HttpRouter, HttpServer } from "@effect/platform";
import { Layer } from "effect";

import { CoreExecutorApi } from "@executor/api";
import { CoreHandlers } from "@executor/api/server";
import { OpenApiGroup, OpenApiHandlers } from "@executor/plugin-openapi/api";
import { McpGroup, McpHandlers } from "@executor/plugin-mcp/api";
import { GoogleDiscoveryGroup, GoogleDiscoveryHandlers } from "@executor/plugin-google-discovery/api";
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
import { DbService } from "../services/db";
import { TeamOrgApi } from "../team/compose";
import { TeamHandlers } from "../team/handlers";

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

const TeamApiLive = HttpApiBuilder.api(TeamOrgApi).pipe(
  Layer.provide(TeamHandlers),
  Layer.provideMerge(OrgAuthLive),
);

const createNonProtectedHandler = () =>
  HttpApiBuilder.toWebHandler(
    NonProtectedApiLive.pipe(Layer.provideMerge(SharedServices), Layer.provideMerge(RouterConfig)),
    { middleware: HttpMiddleware.logger },
  );

const createTeamHandler = () =>
  HttpApiBuilder.toWebHandler(
    TeamApiLive.pipe(Layer.provideMerge(SharedServices), Layer.provideMerge(RouterConfig)),
    { middleware: HttpMiddleware.logger },
  );

const runWithFreshHandler = async (
  createHandler: typeof createNonProtectedHandler,
  request: Request,
): Promise<Response> => {
  const handler = createHandler();
  try {
    return await handler.handler(request);
  } finally {
    await handler.dispose();
  }
};

export const handleNonProtectedRequest = (request: Request): Promise<Response> =>
  runWithFreshHandler(createNonProtectedHandler, request);

export const handleTeamRequest = (request: Request): Promise<Response> =>
  runWithFreshHandler(createTeamHandler, request);
