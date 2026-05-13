import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { Effect } from "effect";

import { makeInMemoryBlobStore } from "./blob";
import type { ExecutorConfig } from "./executor";
import { collectSchemas } from "./executor";
import { ScopeId } from "./ids";
import { definePlugin, type AnyPlugin } from "./plugin";
import { Scope } from "./scope";
import type { SecretProvider } from "./secrets";

// ---------------------------------------------------------------------------
// makeTestConfig — build an ExecutorConfig backed by in-memory adapter +
// blob store. For unit tests, plugin authors validating their plugin,
// REPL experimentation. No persistence.
//
// Defaults to a single-element scope stack ("test-scope") — tests that
// need multi-scope behavior can pass `scopes` explicitly.
// ---------------------------------------------------------------------------

export const makeTestConfig = <const TPlugins extends readonly AnyPlugin[] = []>(options?: {
  readonly scopeName?: string;
  readonly scopes?: readonly Scope[];
  readonly plugins?: TPlugins;
}): ExecutorConfig<TPlugins> => {
  const scopes = options?.scopes ?? [
    Scope.make({
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
    // Tests default to auto-accepting elicitation prompts. Override via
    // a wrapping spread if a test exercises a real handler:
    //   { ...makeTestConfig(...), onElicitation: customHandler }
    onElicitation: "accept-all",
  };
};

export const memorySecretsPlugin = definePlugin(() => {
  const store = new Map<string, string>();

  const provider: SecretProvider = {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(`${scope}\u0000${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}\u0000${id}`, value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(`${scope}\u0000${id}`)),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => {
          const name = key.split("\u0000", 2)[1] ?? key;
          return { id: name, name };
        }),
      ),
  };

  return {
    id: "memory-secrets" as const,
    storage: () => ({}),
    secretProviders: [provider],
  };
});
