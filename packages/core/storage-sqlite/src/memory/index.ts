import { Effect } from "effect";
import { ScopeId, Scope, type SecretProvider } from "@executor/sdk";

import { makeInMemorySqliteStores } from "../index";

export interface InMemoryConfigOptions {
  readonly cwd?: string;
  readonly scopeId?: string;
  readonly encryptionKey?: string;
  readonly secretProviders?: readonly SecretProvider[];
}

/**
 * Build a fully-spreadable executor config bundle backed by an in-memory
 * SQLite database. Returns `{ scope, stores, encryptionKey, secretProviders }`
 * ready to spread into `createExecutor({ ...config, plugins })`.
 */
export const makeInMemoryConfig = (options?: InMemoryConfigOptions) =>
  Effect.sync(() => {
    const cwd = options?.cwd ?? "/memory";
    const scope = new Scope({
      id: ScopeId.make(options?.scopeId ?? "memory-scope"),
      name: cwd,
      createdAt: new Date(),
    });
    return {
      scope,
      stores: makeInMemorySqliteStores(),
      encryptionKey: options?.encryptionKey ?? "memory-default-key",
      secretProviders: options?.secretProviders,
    };
  });

export { makeInMemorySqliteStores } from "../index";
