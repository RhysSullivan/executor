import { HttpApiBuilder } from "@effect/platform";
import * as Effect from "effect/Effect";

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
          executor.effect.local.installation().pipe(
            Effect.mapError(toStorageError("local.installation")),
          )
        )
      )
      .handle("config", () =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.effect.local.config().pipe(
            Effect.mapError(toStorageError("local.config")),
          )
        )
      )
      .handle("listSecrets", () =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.effect.secrets.list().pipe(
            Effect.mapError(toStorageError("local.listSecrets")),
          )
        )
      )
      .handle("createSecret", ({ payload }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.effect.secrets.create(payload).pipe(
            Effect.mapError(toStorageError("local.createSecret")),
          )
        )
      )
      .handle("updateSecret", ({ path, payload }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.effect.secrets.update({
              secretId: path.secretId,
              payload,
            }).pipe(Effect.mapError(toStorageError("local.updateSecret")))
        )
      )
      .handle("deleteSecret", ({ path }) =>
        Effect.flatMap(getControlPlaneExecutor(), (executor) =>
          executor.effect.secrets.remove(path.secretId).pipe(
            Effect.mapError(toStorageError("local.deleteSecret")),
          )
        )
      ),
);
