import { HttpApiBuilder, HttpServer } from "@effect/platform";
import * as Layer from "effect/Layer";

import { ControlPlaneApi } from "./api";
import {
  ControlPlaneActorResolver,
  type ControlPlaneActorResolverShape,
} from "./auth/actor-resolver";
import { ControlPlaneService } from "./service";
import { ControlPlaneCredentialsLive } from "./credentials/http";
import { ControlPlaneInteractionsLive } from "./interactions/http";
import { ControlPlaneOrganizationsLive } from "./organizations/http";
import { ControlPlanePoliciesLive } from "./policies/http";
import { ControlPlaneStorageLive } from "./storage/http";
import { ControlPlaneSourcesLive } from "./sources/http";
import { ControlPlaneToolsLive } from "./tools/http";
import { ControlPlaneWorkspacesLive } from "./workspaces/http";

export const ControlPlaneApiLive = HttpApiBuilder.api(ControlPlaneApi).pipe(
  Layer.provide(ControlPlaneSourcesLive),
  Layer.provide(ControlPlaneCredentialsLive),
  Layer.provide(ControlPlanePoliciesLive),
  Layer.provide(ControlPlaneOrganizationsLive),
  Layer.provide(ControlPlaneWorkspacesLive),
  Layer.provide(ControlPlaneToolsLive),
  Layer.provide(ControlPlaneStorageLive),
  Layer.provide(ControlPlaneInteractionsLive),
);

export const makeControlPlaneWebHandler = <EService, EResolver>(
  serviceLayer: Layer.Layer<ControlPlaneService, EService, never>,
  actorResolverLayer: Layer.Layer<ControlPlaneActorResolver, EResolver, never>,
) => {
  const apiLayer = ControlPlaneApiLive.pipe(
    Layer.provide(serviceLayer),
    Layer.provide(actorResolverLayer),
  );

  return HttpApiBuilder.toWebHandler(
    Layer.merge(apiLayer, HttpServer.layerContext),
  );
};

export const ControlPlaneActorResolverLive = (
  resolver: ControlPlaneActorResolverShape,
) => Layer.succeed(ControlPlaneActorResolver, resolver);
