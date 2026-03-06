import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ControlPlaneActorResolver,
  ControlPlaneService,
  makeControlPlaneWebHandler,
  type ControlPlaneActorResolverShape,
  type ControlPlaneServiceShape,
} from "#api";
import {
  makeSqlControlPlanePersistence,
  SqlPersistenceBootstrapError,
  type CreateSqlRuntimeOptions,
  type SqlControlPlanePersistence,
} from "#persistence";

import {
  ControlPlaneAuthHeaders,
  makeHeaderActorResolver,
} from "./actor-resolver";
import {
  makeInMemorySecretProvider,
  makeSecretStore,
  type SecretStore,
} from "./secret-store";
import { makeRuntimeControlPlaneService } from "./services";

export {
  ControlPlaneAuthHeaders,
  makeHeaderActorResolver,
  makeRuntimeControlPlaneService,
  makeSecretStore,
  makeInMemorySecretProvider,
};

export type { SecretHandle, SecretProvider, SecretStore } from "./secret-store";
export * from "./source-runtime";

export type RuntimeControlPlaneInput = {
  persistence: SqlControlPlanePersistence;
  actorResolver?: ControlPlaneActorResolverShape;
  secretStore?: SecretStore;
};

export const makeRuntimeControlPlane = (
  input: RuntimeControlPlaneInput,
): {
  service: ControlPlaneServiceShape;
  actorResolver: ControlPlaneActorResolverShape;
  secretStore: SecretStore;
  webHandler: ReturnType<typeof makeControlPlaneWebHandler>;
} => {
  const service = makeRuntimeControlPlaneService(input.persistence.rows);
  const actorResolver = input.actorResolver ?? makeHeaderActorResolver(input.persistence.rows);
  const secretStore =
    input.secretStore
    ?? makeSecretStore({
      providers: [makeInMemorySecretProvider("memory")],
      defaultProviderId: "memory",
    });

  const serviceLayer = Layer.succeed(ControlPlaneService, service);
  const actorResolverLayer = Layer.succeed(ControlPlaneActorResolver, actorResolver);

  const webHandler = makeControlPlaneWebHandler(serviceLayer, actorResolverLayer);

  return {
    service,
    actorResolver,
    secretStore,
    webHandler,
  };
};

export type SqlControlPlaneRuntime = {
  persistence: SqlControlPlanePersistence;
  service: ControlPlaneServiceShape;
  actorResolver: ControlPlaneActorResolverShape;
  secretStore: SecretStore;
  webHandler: ReturnType<typeof makeControlPlaneWebHandler>;
  close: () => Promise<void>;
};

export type CreateSqlControlPlaneRuntimeOptions = CreateSqlRuntimeOptions & {
  secretStore?: SecretStore;
  actorResolver?: ControlPlaneActorResolverShape;
};

export const makeSqlControlPlaneRuntime = (
  options: CreateSqlControlPlaneRuntimeOptions,
): Effect.Effect<SqlControlPlaneRuntime, SqlPersistenceBootstrapError> =>
  Effect.map(makeSqlControlPlanePersistence(options), (persistence) => {
    const runtime = makeRuntimeControlPlane({
      persistence,
      actorResolver: options.actorResolver,
      secretStore: options.secretStore,
    });

    return {
      persistence,
      service: runtime.service,
      actorResolver: runtime.actorResolver,
      secretStore: runtime.secretStore,
      webHandler: runtime.webHandler,
      close: () => persistence.close(),
    };
  });
