import { ScopeId } from "./ids";
import type { Scope } from "./scope";
import type { ExecutorConfig } from "./executor";
import type { ExecutorPlugin } from "./plugin";

import { makeInMemoryToolRegistry } from "./in-memory/tool-registry";
import { makeInMemorySecretStore } from "./in-memory/secret-store";
import { makeInMemoryPolicyEngine } from "./in-memory/policy-engine";
import { makeInMemorySourceRegistry } from "./sources";

// ---------------------------------------------------------------------------
// makeTestConfig — one-liner to build a test ExecutorConfig
// ---------------------------------------------------------------------------

export const makeTestConfig = <
  const TPlugins extends readonly ExecutorPlugin<string, object>[] = [],
>(
  options?: {
    readonly cwd?: string;
    readonly plugins?: TPlugins;
  },
): ExecutorConfig<TPlugins> => {
  const cwd = options?.cwd ?? "/test";
  const scope: Scope = {
    id: ScopeId.make("test-scope"),
    name: cwd,
    createdAt: new Date(),
  };

  return {
    scope,
    tools: makeInMemoryToolRegistry(),
    sources: makeInMemorySourceRegistry(),
    secrets: makeInMemorySecretStore(),
    policies: makeInMemoryPolicyEngine(),
    plugins: options?.plugins,
  };
};
