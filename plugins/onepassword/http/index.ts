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
  ControlPlaneStorageError,
  type ExecutorHttpPlugin,
} from "@executor/platform-api";
import { resolveRequestedLocalWorkspace } from "@executor/platform-api/local-context";
import { ScopeIdSchema } from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";

import {
  OnePasswordDiscoverVaultsInputSchema,
  OnePasswordDiscoverVaultsResultSchema,
  OnePasswordDiscoverStoreItemsInputSchema,
  OnePasswordDiscoverStoreItemsResultSchema,
  OnePasswordDiscoverItemFieldsInputSchema,
  OnePasswordDiscoverItemFieldsResultSchema,
  OnePasswordImportSecretInputSchema,
  OnePasswordImportSecretResultSchema,
  type OnePasswordDiscoverVaultsInput,
  type OnePasswordDiscoverVaultsResult,
  type OnePasswordDiscoverItemFieldsInput,
  type OnePasswordDiscoverItemFieldsResult,
  type OnePasswordDiscoverStoreItemsInput,
  type OnePasswordDiscoverStoreItemsResult,
  type OnePasswordImportSecretInput,
  type OnePasswordImportSecretResult,
} from "@executor/plugin-onepassword-shared";

type OnePasswordExecutorExtension = {
  onepassword: {
    discoverVaults: (
      input: OnePasswordDiscoverVaultsInput,
    ) => Effect.Effect<OnePasswordDiscoverVaultsResult, Error>;
    discoverStoreItems: (
      input: OnePasswordDiscoverStoreItemsInput,
    ) => Effect.Effect<OnePasswordDiscoverStoreItemsResult, Error>;
    discoverItemFields: (
      input: OnePasswordDiscoverItemFieldsInput,
    ) => Effect.Effect<OnePasswordDiscoverItemFieldsResult, Error>;
    importSecret: (
      input: OnePasswordImportSecretInput,
    ) => Effect.Effect<OnePasswordImportSecretResult, Error>;
  };
};

const workspaceIdParam = HttpApiSchema.param("workspaceId", ScopeIdSchema);

const OnePasswordHttpGroup = HttpApiGroup.make("onepassword")
  .add(
    HttpApiEndpoint.post("discoverVaults")`/workspaces/${workspaceIdParam}/plugins/onepassword/vaults/discover`
      .setPayload(OnePasswordDiscoverVaultsInputSchema)
      .addSuccess(OnePasswordDiscoverVaultsResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("discoverStoreItems")`/workspaces/${workspaceIdParam}/plugins/onepassword/stores/discover-items`
      .setPayload(OnePasswordDiscoverStoreItemsInputSchema)
      .addSuccess(OnePasswordDiscoverStoreItemsResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("discoverItemFields")`/workspaces/${workspaceIdParam}/plugins/onepassword/items/discover-fields`
      .setPayload(OnePasswordDiscoverItemFieldsInputSchema)
      .addSuccess(OnePasswordDiscoverItemFieldsResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .add(
    HttpApiEndpoint.post("importSecret")`/workspaces/${workspaceIdParam}/plugins/onepassword/secrets/import`
      .setPayload(OnePasswordImportSecretInputSchema)
      .addSuccess(OnePasswordImportSecretResultSchema)
      .addError(ControlPlaneBadRequestError)
      .addError(ControlPlaneForbiddenError)
      .addError(ControlPlaneStorageError),
  )
  .prefix("/v1");

const OnePasswordHttpApi = HttpApi.make("executor").add(OnePasswordHttpGroup);

const toStorageError = (operation: string, cause: unknown) =>
  new ControlPlaneStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    details: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });

export const onePasswordHttpPlugin = (): ExecutorHttpPlugin<
  typeof OnePasswordHttpGroup,
  OnePasswordExecutorExtension
> => ({
  key: "onepassword",
  group: OnePasswordHttpGroup,
  build: ({ executor }) =>
    HttpApiBuilder.group(OnePasswordHttpApi, "onepassword", (handlers) =>
      handlers
        .handle("discoverVaults", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "onepassword.discoverVaults",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.onepassword.discoverVaults(payload)),
            Effect.mapError((cause) =>
              toStorageError("onepassword.discoverVaults", cause)
            ),
          ))
        .handle("discoverStoreItems", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "onepassword.discoverStoreItems",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.onepassword.discoverStoreItems(payload)),
            Effect.mapError((cause) =>
              toStorageError("onepassword.discoverStoreItems", cause)
            ),
          ))
        .handle("discoverItemFields", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "onepassword.discoverItemFields",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.onepassword.discoverItemFields(payload)),
            Effect.mapError((cause) =>
              toStorageError("onepassword.discoverItemFields", cause)
            ),
          ))
        .handle("importSecret", ({ path, payload }) =>
          resolveRequestedLocalWorkspace(
            "onepassword.importSecret",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.onepassword.importSecret(payload)),
            Effect.mapError((cause) =>
              toStorageError("onepassword.importSecret", cause)
            ),
          ))
    ),
});
