import { makeMemoryAdapter } from "@executor/storage-core/testing/memory";

import { makeInMemoryBlobStore } from "./blob";
import type { ExecutorConfig } from "./executor";
import { collectSchemas } from "./executor";
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

  const schema = collectSchemas(options?.plugins ?? []);

  return {
    scope,
    adapter: makeMemoryAdapter({ schema }),
    blobs: makeInMemoryBlobStore(),
    plugins: options?.plugins,
  };
};
