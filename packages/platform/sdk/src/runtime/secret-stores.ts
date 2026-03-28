import {
  type ScopeId,
  SecretStoreIdSchema,
  type SecretStore,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  ExecutorStateStore,
} from "./executor-state-store";
import {
  runtimeEffectError,
} from "./effect-errors";

export const listManagedSecretStores = () =>
  Effect.flatMap(ExecutorStateStore, (store) => store.secretStores.listAll());

export const getManagedSecretStore = (storeId: SecretStore["id"]) =>
  Effect.gen(function* () {
    const store = yield* ExecutorStateStore;
    const existing = yield* store.secretStores.getById(storeId);
    if (Option.isNone(existing)) {
      return yield* runtimeEffectError(
        "secret-stores",
        `Secret store not found: ${storeId}`,
      );
    }

    return existing.value;
  });

export const createManagedSecretStoreRecord = (input: {
  scopeId: ScopeId;
  store: Omit<
    SecretStore,
    "id" | "scopeId" | "createdAt" | "updatedAt"
  >;
  storeId?: SecretStore["id"];
}) =>
  Effect.gen(function* () {
    const executorState = yield* ExecutorStateStore;
    const now = Date.now();
    const store: SecretStore = {
      id:
        input.storeId
        ?? SecretStoreIdSchema.make(`sts_${crypto.randomUUID()}`),
      scopeId: input.scopeId,
      createdAt: now,
      updatedAt: now,
      ...input.store,
    };
    yield* executorState.secretStores.upsert(store);
    return store;
  });

export const saveManagedSecretStoreRecord = (
  store: SecretStore,
) =>
  Effect.gen(function* () {
    const executorState = yield* ExecutorStateStore;
    const nextStore: SecretStore = {
      ...store,
      updatedAt: Date.now(),
    };
    yield* executorState.secretStores.upsert(nextStore);
    return nextStore;
  });

export const removeManagedSecretStoreRecord = (
  storeId: SecretStore["id"],
) =>
  Effect.gen(function* () {
    const executorState = yield* ExecutorStateStore;
    return yield* executorState.secretStores.removeById(storeId);
  });
