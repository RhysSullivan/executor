import { Effect } from "effect";

import type { StorageFailure } from "./fuma-runtime";
import type { ScopeId } from "./ids";

export interface PluginStorageKeyInput {
  readonly collection: string;
  readonly key: string;
}

export interface PluginStorageScopedKeyInput extends PluginStorageKeyInput {
  readonly scope: ScopeId | string;
}

export interface PluginStorageListInput {
  readonly collection: string;
  readonly keyPrefix?: string;
}

export interface PluginStoragePutInput extends PluginStorageScopedKeyInput {
  readonly data: unknown;
}

export interface PluginStorageEntry<T = unknown> {
  readonly id: string;
  readonly scopeId: ScopeId | string;
  readonly pluginId: string;
  readonly collection: string;
  readonly key: string;
  readonly data: T;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PluginStorageFacade {
  readonly get: <T = unknown>(
    input: PluginStorageKeyInput,
  ) => Effect.Effect<PluginStorageEntry<T> | null, StorageFailure>;
  readonly getAtScope: <T = unknown>(
    input: PluginStorageScopedKeyInput,
  ) => Effect.Effect<PluginStorageEntry<T> | null, StorageFailure>;
  readonly list: <T = unknown>(
    input: PluginStorageListInput,
  ) => Effect.Effect<readonly PluginStorageEntry<T>[], StorageFailure>;
  readonly put: <T = unknown>(
    input: PluginStoragePutInput,
  ) => Effect.Effect<PluginStorageEntry<T>, StorageFailure>;
  readonly remove: (input: PluginStorageScopedKeyInput) => Effect.Effect<void, StorageFailure>;
}

export const pluginStorageId = (input: {
  readonly pluginId: string;
  readonly collection: string;
  readonly key: string;
}): string => JSON.stringify([input.pluginId, input.collection, input.key]);
