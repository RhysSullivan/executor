import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServer } from "effect/unstable/http";
import { Layer } from "effect";

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
import { ProtectedCloudApi, RouterConfig } from "./protected-layers";

export {
  CoreSharedServices,
  ProtectedCloudApi,
  RouterConfig,
};

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));

export const SharedServices = Layer.mergeAll(
  DbLive,
  UserStoreLive,
  CoreSharedServices,
  HttpServer.layerServices,
  TelemetryLive,
);

// Routes that don't require an authenticated org session — login,
// callbacks, etc. Mounts at the paths declared inside `NonProtectedApi`.
export const NonProtectedApiLive = HttpApiBuilder.layer(NonProtectedApi).pipe(
  Layer.provide(Layer.mergeAll(CloudAuthPublicHandlers, CloudSessionAuthHandlers)),
  Layer.provideMerge(SessionAuthLive),
);

// Routes scoped to a specific org (membership management, switching, etc.).
// Auth is enforced by `OrgAuth` middleware declared on `OrgHttpApi`.
export const OrgApiLive = HttpApiBuilder.layer(OrgHttpApi).pipe(
  Layer.provide(OrgHandlers),
  Layer.provideMerge(OrgAuthLive),
);
