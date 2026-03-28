import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "@effect/platform";
import {
  ControlPlaneNotFoundError,
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
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
  OpenApiConnectInputSchema,
  OpenApiPreviewRequestSchema,
  OpenApiPreviewResponseSchema,
  OpenApiSourceConfigPayloadSchema,
  type OpenApiConnectInput,
  type OpenApiPreviewRequest,
  type OpenApiPreviewResponse,
  type OpenApiSourceConfigPayload,
  type OpenApiUpdateSourceInput,
} from "@executor/plugin-openapi-shared";

type OpenApiExecutorExtension = {
  openapi: {
    previewDocument: (
      input: OpenApiPreviewRequest,
    ) => Effect.Effect<OpenApiPreviewResponse, Error, never>;
    createSource: (
      input: OpenApiConnectInput,
    ) => Effect.Effect<Source, Error, never>;
    getSourceConfig: (
      sourceId: Source["id"],
    ) => Effect.Effect<OpenApiSourceConfigPayload, Error, never>;
    updateSource: (
      input: OpenApiUpdateSourceInput,
    ) => Effect.Effect<Source, Error, never>;
    refreshSource: (
      sourceId: Source["id"],
    ) => Effect.Effect<Source, Error, never>;
    removeSource: (
      sourceId: Source["id"],
    ) => Effect.Effect<boolean, Error, never>;
  };
};

const workspaceIdParam = HttpApiSchema.param("workspaceId", ScopeIdSchema);
const sourceIdParam = HttpApiSchema.param("sourceId", SourceIdSchema);

export const OpenApiHttpGroup = HttpApiGroup.make("openapi")
  .add(
    HttpApiEndpoint.post("previewDocument")`/workspaces/${workspaceIdParam}/plugins/openapi/preview`
      .setPayload(OpenApiPreviewRequestSchema)
      .addSuccess(OpenApiPreviewResponseSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("createSource")`/workspaces/${workspaceIdParam}/plugins/openapi/sources`
      .setPayload(OpenApiConnectInputSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.get("getSourceConfig")`/workspaces/${workspaceIdParam}/plugins/openapi/sources/${sourceIdParam}`
      .addSuccess(OpenApiSourceConfigPayloadSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.put("updateSource")`/workspaces/${workspaceIdParam}/plugins/openapi/sources/${sourceIdParam}`
      .setPayload(OpenApiSourceConfigPayloadSchema)
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("refreshSource")`/workspaces/${workspaceIdParam}/plugins/openapi/sources/${sourceIdParam}/refresh`
      .addSuccess(SourceSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.del("removeSource")`/workspaces/${workspaceIdParam}/plugins/openapi/sources/${sourceIdParam}`
      .addSuccess(Schema.Struct({ removed: Schema.Boolean }))
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneNotFoundError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1");

export const OpenApiHttpApi = HttpApi.make("executor").add(OpenApiHttpGroup);

export const openApiHttpApiExtension = {
  key: "openapi",
  group: OpenApiHttpGroup,
} satisfies ExecutorHttpApiExtension<typeof OpenApiHttpGroup>;

const toBadRequestError = (operation: string) => (cause: unknown) =>
  new ControlPlaneBadRequestError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    details: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });

const toStorageError = (operation: string) => (cause: unknown) =>
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

const mapPluginStorageError = (operation: string) => (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("not found") || message.includes("Not found")) {
    return toNotFoundError(operation, cause);
  }

  return toStorageError(operation)(cause);
};

export const openApiHttpPlugin = (): ExecutorHttpPlugin<
  typeof OpenApiHttpGroup,
  OpenApiExecutorExtension
> => ({
  key: "openapi",
  group: OpenApiHttpGroup,
  build: ({ executor }) =>
    HttpApiBuilder.group(OpenApiHttpApi, "openapi", (handlers) =>
      handlers
        .handle("previewDocument", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "openapi.previewDocument",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.openapi.previewDocument(payload)),
            Effect.mapError(toBadRequestError("openapi.previewDocument")),
          )
        )
        .handle("createSource", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "openapi.createSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.openapi.createSource(payload)),
            Effect.mapError(toStorageError("openapi.createSource")),
          )
        )
        .handle("getSourceConfig", ({ path }) =>
          resolveRequestedLocalWorkspace(
            "openapi.getSourceConfig",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.openapi.getSourceConfig(path.sourceId)),
            Effect.mapError(mapPluginStorageError("openapi.getSourceConfig")),
          )
        )
        .handle("updateSource", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "openapi.updateSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() =>
              executor.openapi.updateSource({
                sourceId: path.sourceId,
                config: payload,
              })
            ),
            Effect.mapError(mapPluginStorageError("openapi.updateSource")),
          )
        )
        .handle("refreshSource", ({ path }) =>
          resolveRequestedLocalWorkspace(
            "openapi.refreshSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.openapi.refreshSource(path.sourceId)),
            Effect.mapError(mapPluginStorageError("openapi.refreshSource")),
          )
        )
        .handle("removeSource", ({ path }) =>
          resolveRequestedLocalWorkspace(
            "openapi.removeSource",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.openapi.removeSource(path.sourceId)),
            Effect.map((removed) => ({ removed })),
            Effect.mapError(mapPluginStorageError("openapi.removeSource")),
          )
        )
    ),
});
