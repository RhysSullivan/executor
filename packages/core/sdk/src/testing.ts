import { makeInMemoryAdapter } from "@executor/storage-memory";

import { makeInMemoryBlobStore } from "./blob";
import type { ExecutorConfig } from "./executor";
import { ScopeId } from "./ids";
import type { AnyPlugin } from "./plugin";
import { Scope } from "./scope";

// ---------------------------------------------------------------------------
// makeTestConfig — build an ExecutorConfig backed by in-memory adapter +
// blob store. For unit tests, plugin authors validating their plugin,
// REPL experimentation. No persistence.
// ---------------------------------------------------------------------------

export const makeTestConfig = <
  const TPlugins extends readonly AnyPlugin[] = [],
>(options?: {
  readonly scopeName?: string;
  readonly plugins?: TPlugins;
}): ExecutorConfig<TPlugins> => {
  const scope = new Scope({
    id: ScopeId.make("test-scope"),
    name: options?.scopeName ?? "test",
    createdAt: new Date(),
  });

  return {
    scope,
    adapter: makeInMemoryAdapter(),
    blobs: makeInMemoryBlobStore(),
    plugins: options?.plugins,
  };
};
