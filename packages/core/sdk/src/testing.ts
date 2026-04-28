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
//
// Defaults to a single-element scope stack ("test-scope") — tests that
// need multi-scope behavior can pass `scopes` explicitly.
// ---------------------------------------------------------------------------

export const makeTestConfig = <
  const TPlugins extends readonly AnyPlugin[] = [],
>(options?: {
  readonly scopeName?: string;
  readonly scopes?: readonly Scope[];
  readonly plugins?: TPlugins;
}): ExecutorConfig<TPlugins> => {
  const scopes =
    options?.scopes ?? [
      new Scope({
        id: ScopeId.make("test-scope"),
        name: options?.scopeName ?? "test",
        createdAt: new Date(),
      }),
    ];

  const schema = collectSchemas(options?.plugins ?? []);

  return {
    scopes,
    adapter: makeMemoryAdapter({ schema }),
    blobs: makeInMemoryBlobStore(),
    plugins: options?.plugins,
  };
};
