import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { SecretMaterialIdSchema } from "../schema";
import {
  type CreateSecretPayload,
  type CreateSecretResult,
  type DeleteSecretResult,
  type InstanceConfig,
  type SecretListItem,
  type UpdateSecretPayload,
  type UpdateSecretResult,
} from "./contracts";
import {
  ControlPlaneBadRequestError,
  ControlPlaneNotFoundError,
  ControlPlaneStorageError,
} from "../errors";
import { requireRuntimeLocalWorkspace } from "../runtime/workspace/runtime-context";
import {
  LocalInstanceConfigService,
  SecretMaterialDeleterService,
  SecretMaterialStorerService,
  SecretMaterialUpdaterService,
} from "../runtime/workspace/secret-material-providers";
import { RuntimeSourceStoreService } from "../runtime/sources/source-store";
import { ExecutorStateStore } from "../runtime/executor-state-store";

const secretStorageError = (operation: string, message: string) =>
  new ControlPlaneStorageError({
    operation,
    message,
    details: message,
  });

export const getLocalInstanceConfig = (): Effect.Effect<InstanceConfig, Error, LocalInstanceConfigService> =>
  Effect.flatMap(LocalInstanceConfigService, (resolveInstanceConfig) => resolveInstanceConfig());

export const listLocalSecrets = () =>
  Effect.gen(function* () {
    const store = yield* ExecutorStateStore;
    const sourceStore = yield* RuntimeSourceStoreService;
    const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace().pipe(
      Effect.mapError(() =>
        secretStorageError("secrets.list", "Failed resolving local workspace."),
      ),
    );
    const secretMaterials = yield* store.secretMaterials
      .listAll()
      .pipe(
        Effect.mapError(() =>
          secretStorageError("secrets.list", "Failed listing secrets."),
        ),
      );
    const linkedSourcesMap = yield* sourceStore
      .listLinkedSecretSourcesInWorkspace(
        runtimeLocalWorkspace.installation.workspaceId,
        {
          actorAccountId: runtimeLocalWorkspace.installation.accountId,
        },
      )
      .pipe(
        Effect.mapError(() =>
          secretStorageError("secrets.list", "Failed loading linked sources."),
        ),
      );

    return secretMaterials.map((row) => ({
      ...row,
      linkedSources: linkedSourcesMap.get(row.id) ?? [],
    }));
  });

export const createLocalSecret = (payload: CreateSecretPayload) =>
  Effect.gen(function* () {
    const name = payload.name.trim();
    const value = payload.value;
    const purpose = payload.purpose ?? "auth_material";

    if (name.length === 0) {
      return yield* new ControlPlaneBadRequestError({
        operation: "secrets.create",
        message: "Secret name is required.",
        details: "Secret name is required.",
      });
    }

    const store = yield* ExecutorStateStore;
    const storeSecretMaterial = yield* SecretMaterialStorerService;
    const ref = yield* storeSecretMaterial({
      name,
      purpose,
      value,
      providerId: payload.providerId,
    }).pipe(
      Effect.mapError((cause) =>
        secretStorageError(
          "secrets.create",
          cause instanceof Error ? cause.message : "Failed creating secret.",
        ),
      ),
    );
    const secretId = SecretMaterialIdSchema.make(ref.handle);
    const created = yield* store.secretMaterials
      .getById(secretId)
      .pipe(
        Effect.mapError(() =>
          secretStorageError(
            "secrets.create",
            "Failed loading created secret.",
          ),
        ),
      );

    if (Option.isNone(created)) {
      return yield* secretStorageError(
        "secrets.create",
        `Created secret not found: ${ref.handle}`,
      );
    }

    return {
      id: created.value.id,
      name: created.value.name,
      providerId: created.value.providerId,
      purpose: created.value.purpose,
      createdAt: created.value.createdAt,
      updatedAt: created.value.updatedAt,
    } satisfies CreateSecretResult;
  });

export const updateLocalSecret = (input: {
  secretId: string;
  payload: UpdateSecretPayload;
}) =>
  Effect.gen(function* () {
    const secretId = SecretMaterialIdSchema.make(input.secretId);
    const store = yield* ExecutorStateStore;

    const existing = yield* store.secretMaterials
      .getById(secretId)
      .pipe(
        Effect.mapError(() =>
          secretStorageError("secrets.update", "Failed looking up secret."),
        ),
      );

    if (Option.isNone(existing)) {
      return yield* new ControlPlaneNotFoundError({
        operation: "secrets.update",
        message: `Secret not found: ${input.secretId}`,
        details: `Secret not found: ${input.secretId}`,
      });
    }

    const update: { name?: string | null; value?: string } = {};
    if (input.payload.name !== undefined)
      update.name = input.payload.name.trim() || null;
    if (input.payload.value !== undefined) update.value = input.payload.value;

    const updateSecretMaterial = yield* SecretMaterialUpdaterService;
    const updated = yield* updateSecretMaterial({
      ref: {
        providerId: existing.value.providerId,
        handle: existing.value.id,
      },
      ...update,
    }).pipe(
      Effect.mapError(() =>
        secretStorageError("secrets.update", "Failed updating secret."),
      ),
    );

    return {
      id: updated.id,
      providerId: updated.providerId,
      name: updated.name,
      purpose: updated.purpose,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    } satisfies UpdateSecretResult;
  });

export const deleteLocalSecret = (secretId: string) =>
  Effect.gen(function* () {
    const parsedSecretId = SecretMaterialIdSchema.make(secretId);
    const store = yield* ExecutorStateStore;

    const existing = yield* store.secretMaterials
      .getById(parsedSecretId)
      .pipe(
        Effect.mapError(() =>
          secretStorageError("secrets.delete", "Failed looking up secret."),
        ),
      );

    if (Option.isNone(existing)) {
      return yield* new ControlPlaneNotFoundError({
        operation: "secrets.delete",
        message: `Secret not found: ${secretId}`,
        details: `Secret not found: ${secretId}`,
      });
    }

    const deleteSecretMaterial = yield* SecretMaterialDeleterService;
    const removed = yield* deleteSecretMaterial({
      providerId: existing.value.providerId,
      handle: existing.value.id,
    }).pipe(
      Effect.mapError(() =>
        secretStorageError("secrets.delete", "Failed removing secret."),
      ),
    );

    if (!removed) {
      return yield* secretStorageError(
        "secrets.delete",
        `Failed removing secret: ${secretId}`,
      );
    }

    return { removed: true } satisfies DeleteSecretResult;
  });
