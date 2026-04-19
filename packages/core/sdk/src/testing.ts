import { makeMemoryAdapter } from "@executor/storage-core/testing/memory";

import { makeInMemoryBlobStore } from "./blob";
import type { ExecutorConfig } from "./executor";
import { collectSchemas } from "./executor";
import { ScopeId } from "./ids";
import type { AnyPlugin } from "./plugin";
import { Scope, ScopeStack } from "./scope";

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

// ---------------------------------------------------------------------------
// makeTestScope / makeLayeredTestConfig — layered-scope fixtures. Let a
// test write "given user + org + a shared secret, the user sees it" in
// three lines without constructing Scope objects by hand.
// ---------------------------------------------------------------------------

export const makeTestScope = (id: string, name?: string): Scope =>
  new Scope({
    id: ScopeId.make(id),
    name: name ?? id,
    createdAt: new Date(),
  });

/** Build a multi-scope ExecutorConfig. The read chain is the list of
 *  scopes in precedence order (innermost first). The write target is
 *  either `read[0]` (default) or an explicit index.
 *
 *  Both test configs share one in-memory adapter + blob store so
 *  caller A can write at the org scope and caller B can observe the
 *  layering via its user-first chain against the same adapter. Pass
 *  `sharedBacking` to opt into this pattern. */
export const makeLayeredTestConfig = <
  const TPlugins extends readonly AnyPlugin[] = [],
>(options: {
  readonly read: readonly Scope[];
  readonly writeIndex?: number;
  readonly plugins?: TPlugins;
  readonly sharedBacking?: {
    readonly adapter: ReturnType<typeof makeMemoryAdapter>;
    readonly blobs: ReturnType<typeof makeInMemoryBlobStore>;
  };
}): ExecutorConfig<TPlugins> => {
  const read = options.read;
  if (read.length === 0) throw new Error("read chain must be non-empty");
  const write = read[options.writeIndex ?? 0]!;
  const scopeStack = new ScopeStack({ read, write });

  const schema = collectSchemas(options.plugins ?? []);
  const adapter = options.sharedBacking?.adapter ?? makeMemoryAdapter({ schema });
  const blobs = options.sharedBacking?.blobs ?? makeInMemoryBlobStore();

  return {
    scope: scopeStack,
    adapter,
    blobs,
    plugins: options.plugins,
  };
};
