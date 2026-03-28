import {
  HttpApi,
  HttpApiBuilder,
} from "@effect/platform";
import {
  ControlPlaneBadRequestError,
  ControlPlaneForbiddenError,
  ControlPlaneStorageError,
  type ExecutorHttpPlugin,
} from "@executor/platform-api";
import { resolveRequestedLocalWorkspace } from "@executor/platform-api/local-context";
import * as Effect from "effect/Effect";

import {
  OnePasswordDiscoverStoreItemsInputSchema,
  OnePasswordDiscoverItemFieldsInputSchema,
  OnePasswordImportSecretInputSchema,
  type OnePasswordDiscoverVaultsInput,
  type OnePasswordDiscoverVaultsResult,
  type OnePasswordDiscoverItemFieldsInput,
  type OnePasswordDiscoverItemFieldsResult,
  type OnePasswordDiscoverStoreItemsInput,
  type OnePasswordDiscoverStoreItemsResult,
  type OnePasswordImportSecretInput,
  type OnePasswordImportSecretResult,
  onePasswordHttpGroup,
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

const OnePasswordHttpApi = HttpApi.make("executor").add(onePasswordHttpGroup);

const toStorageError = (operation: string, cause: unknown) =>
  new ControlPlaneStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    details: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });

export const onePasswordHttpPlugin = (): ExecutorHttpPlugin<
  typeof onePasswordHttpGroup,
  OnePasswordExecutorExtension
> => ({
  key: "onepassword",
  group: onePasswordHttpGroup,
  build: ({ executor }) =>
    (HttpApiBuilder.group as any)(OnePasswordHttpApi, "onepassword", (handlers: any) =>
      handlers
        .handle("discoverVaults", ({ path, payload }: any) =>
          resolveRequestedLocalWorkspace(
            "onepassword.discoverVaults",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.onepassword.discoverVaults(payload)),
            Effect.mapError((cause) =>
              toStorageError("onepassword.discoverVaults", cause)
            ),
          ))
        .handle("discoverStoreItems", ({ path, payload }: any) =>
          resolveRequestedLocalWorkspace(
            "onepassword.discoverStoreItems",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.onepassword.discoverStoreItems(
              OnePasswordDiscoverStoreItemsInputSchema.make(payload),
            )),
            Effect.mapError((cause) =>
              toStorageError("onepassword.discoverStoreItems", cause)
            ),
          ))
        .handle("discoverItemFields", ({ path, payload }: any) =>
          resolveRequestedLocalWorkspace(
            "onepassword.discoverItemFields",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.onepassword.discoverItemFields(
              OnePasswordDiscoverItemFieldsInputSchema.make(payload),
            )),
            Effect.mapError((cause) =>
              toStorageError("onepassword.discoverItemFields", cause)
            ),
          ))
        .handle("importSecret", ({ path, payload }: any) =>
          resolveRequestedLocalWorkspace(
            "onepassword.importSecret",
            path.workspaceId,
          ).pipe(
            Effect.flatMap(() => executor.onepassword.importSecret(
              OnePasswordImportSecretInputSchema.make(payload),
            )),
            Effect.mapError((cause) =>
              toStorageError("onepassword.importSecret", cause)
            ),
          ))
    ) as any,
});
