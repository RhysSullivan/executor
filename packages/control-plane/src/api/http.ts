import { HttpApiBuilder, HttpServer } from "@effect/platform";
import * as Layer from "effect/Layer";

import { ControlPlaneApi } from "./api";
import {
  ControlPlaneActorResolver,
  type ControlPlaneActorResolverShape,
} from "./auth/actor-resolver";
import { ControlPlaneMembershipsLive } from "./memberships/http";
import { ControlPlaneOrganizationsLive } from "./organizations/http";
import { ControlPlanePoliciesLive } from "./policies/http";
import { ControlPlaneService } from "./service";
import { ControlPlaneSourcesLive } from "./sources/http";
import { ControlPlaneWorkspacesLive } from "./workspaces/http";

export const ControlPlaneApiLive = HttpApiBuilder.api(ControlPlaneApi).pipe(
  Layer.provide(ControlPlaneOrganizationsLive),
  Layer.provide(ControlPlaneMembershipsLive),
  Layer.provide(ControlPlaneWorkspacesLive),
  Layer.provide(ControlPlaneSourcesLive),
  Layer.provide(ControlPlanePoliciesLive),
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
    Layer.merge(apiLayer, HttpServer.layerContext) as any,
  );
};

export const ControlPlaneActorResolverLive = (
  resolver: ControlPlaneActorResolverShape,
) => Layer.succeed(ControlPlaneActorResolver, resolver);
