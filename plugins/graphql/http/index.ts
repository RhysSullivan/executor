import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "@effect/platform";
import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
  type ExecutorHttpApiExtension,
  type ExecutorHttpPlugin,
} from "@executor/platform-api";
import { resolveRequestedLocalWorkspace } from "@executor/platform-api/local-context";
import {
  ScopeIdSchema,
  SourceIdSchema,
  SourceSchema,
  type Source,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  GraphqlConnectInputSchema,
  GraphqlSourceConfigPayloadSchema,
  type GraphqlConnectInput,
  type GraphqlSourceConfigPayload,
  type GraphqlUpdateSourceInput,
} from "@executor/plugin-graphql-shared";

type GraphqlExecutorExtension = {
  graphql: {
    createSource: (
      input: GraphqlConnectInput,
    ) => Effect.Effect<Source, Error>;
    getSourceConfig: (
      sourceId: Source["id"],
    ) => Effect.Effect<GraphqlSourceConfigPayload, Error>;
    updateSource: (
      input: GraphqlUpdateSourceInput,
    ) => Effect.Effect<Source, Error>;
    removeSource: (
      sourceId: Source["id"],
    ) => Effect.Effect<boolean, Error>;
  };
};

const workspaceIdParam = HttpApiSchema.param("workspaceId", ScopeIdSchema);
const sourceIdParam = HttpApiSchema.param("sourceId", SourceIdSchema);

export const GraphqlHttpGroup = HttpApiGroup.make("graphql")
  .add(
    HttpApiEndpoint.post("createSource")`/workspaces/${workspaceIdParam}/plugins/graphql/sources`
      .setPayload(GraphqlConnectInputSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("getSourceConfig")`/workspaces/${workspaceIdParam}/plugins/graphql/sources/${sourceIdParam}`
      .addSuccess(GraphqlSourceConfigPayloadSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.put("updateSource")`/workspaces/${workspaceIdParam}/plugins/graphql/sources/${sourceIdParam}`
      .setPayload(GraphqlSourceConfigPayloadSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("removeSource")`/workspaces/${workspaceIdParam}/plugins/graphql/sources/${sourceIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1");

export const graphqlHttpApiExtension = {
  key: "graphql",
  group: GraphqlHttpGroup,
} satisfies ExecutorHttpApiExtension<typeof GraphqlHttpGroup>;

const GraphqlHttpApi = HttpApi.make("executor").add(GraphqlHttpGroup);

const toStorageError = (operation: string, cause: unknown) =>
  new ControlPlaneStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    details: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });

const toNotFoundError = (operation: string, cause: unknown) =>
  new ControlPlaneNotFoundError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    details: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });

const mapPluginStorageError = (operation: string, cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("not found") || message.includes("Not found")) {
    return toNotFoundError(operation, cause);
  }

  return toStorageError(operation, cause);
};

export const graphqlHttpPlugin = (): ExecutorHttpPlugin<
  typeof GraphqlHttpGroup,
  GraphqlExecutorExtension
> => ({
  key: "graphql",
  group: GraphqlHttpGroup,
  build: ({ executor }) =>
    HttpApiBuilder.group(GraphqlHttpApi, "graphql", (handlers) =>
      handlers
        .handle("createSource", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "graphql.createSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.graphql.createSource(payload)),
            Effect.mapError((cause) =>
              toStorageError("graphql.createSource", cause)
            ),
          )
        )
        .handle("getSourceConfig", ({ path }) =>
          resolveRequestedLocalWorkspace(
            "graphql.getSourceConfig",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.graphql.getSourceConfig(path.sourceId)),
            Effect.mapError((cause) =>
              mapPluginStorageError("graphql.getSourceConfig", cause)
            ),
          )
        )
        .handle("updateSource", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "graphql.updateSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() =>
              executor.graphql.updateSource({
                sourceId: path.sourceId,
                config: payload,
              })
            ),
            Effect.mapError((cause) =>
              mapPluginStorageError("graphql.updateSource", cause)
            ),
          )
        )
        .handle("removeSource", ({ path }) =>
          resolveRequestedLocalWorkspace(
            "graphql.removeSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.graphql.removeSource(path.sourceId)),
            Effect.map((removed) => ({ removed })),
            Effect.mapError((cause) =>
              mapPluginStorageError("graphql.removeSource", cause)
            ),
          )
        )
    ),
});
