import { HttpApiBuilder } from "@effect/platform";
import * as Effect from "effect/Effect";
import {
  LocalInstanceConfigService,
  provideExecutorRuntime,
} from "@executor/platform-sdk/runtime";

import { ExecutorApi } from "../api";
import { ControlPlaneStorageError } from "../errors";
import { getControlPlaneExecutor } from "../executor-context";

const toStorageError = (operation: string) => (cause: unknown) =>
  new ControlPlaneStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    details: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });

export const ExecutorLocalLive = HttpApiBuilder.group(
  ExecutorApi,
  "local",
  (handlers) =>
    handlers
      .handle("installation", () =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          Effect.succeed(executor.installation)
        )
      )
      .handle("config", () =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          provideExecutorRuntime(
            Effect.flatMap(
              LocalInstanceConfigService,
              (resolveInstanceConfig) => resolveInstanceConfig(),
            ),
            executor.runtime,
          ).pipe(
            Effect.mapError(toStorageError("local.config")),
          )
        )
      )
      .handle("listSecretStores", () =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.secretStores.list().pipe(
            Effect.mapError(toStorageError("local.listSecretStores")),
          )
        )
      )
      .handle("createSecretStore", ({ payload }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.secretStores.create(payload).pipe(
            Effect.mapError(toStorageError("local.createSecretStore")),
          )
        )
      )
      .handle("updateSecretStore", ({ path, payload }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.secretStores.update({
              storeId: path.storeId,
              payload,
            }).pipe(Effect.mapError(toStorageError("local.updateSecretStore")))
        )
      )
      .handle("deleteSecretStore", ({ path }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.secretStores.remove(path.storeId).pipe(
            Effect.mapError(toStorageError("local.deleteSecretStore")),
          )
        )
      )
      .handle("browseSecretStore", ({ path, payload }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.secretStores.browse({
            storeId: path.storeId,
            payload,
          }).pipe(
            Effect.mapError(toStorageError("local.browseSecretStore")),
          )
        )
      )
      .handle("importSecretFromStore", ({ path, payload }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.secretStores.import({
            storeId: path.storeId,
            payload,
          }).pipe(
            Effect.mapError(toStorageError("local.importSecretFromStore")),
          )
        )
      )
      .handle("listSecrets", () =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.secrets.list().pipe(
            Effect.mapError(toStorageError("local.listSecrets")),
          )
        )
      )
      .handle("createSecret", ({ payload }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.secrets.create(payload).pipe(
            Effect.mapError(toStorageError("local.createSecret")),
          )
        )
      )
      .handle("updateSecret", ({ path, payload }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.secrets.update({
              secretId: path.secretId,
              payload,
            }).pipe(Effect.mapError(toStorageError("local.updateSecret")))
        )
      )
      .handle("deleteSecret", ({ path }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.secrets.remove(path.secretId).pipe(
            Effect.mapError(toStorageError("local.deleteSecret")),
          )
        )
      ),
);
