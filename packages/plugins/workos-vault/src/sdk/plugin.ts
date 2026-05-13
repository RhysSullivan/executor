import { Effect } from "effect";

import { definePlugin } from "@executor-js/sdk/core";

import {
  makeConfiguredWorkOSVaultClient,
  type WorkOSVaultClient,
  WorkOSVaultClientInstantiationError,
  type WorkOSVaultCredentials,
} from "./client";
import {
  WORKOS_VAULT_PROVIDER_KEY,
  makeWorkOSVaultSecretProvider,
  makeWorkosVaultStore,
  workosVaultSchema,
  type WorkOSVaultContextForScope,
  type WorkosVaultStore,
} from "./secret-store";

// ---------------------------------------------------------------------------
// Plugin options — either pass a pre-built client (for tests / injection)
// or the WorkOS credentials to build one at startup. An `objectPrefix`
// override is available for multi-tenant installations.
// ---------------------------------------------------------------------------

export interface WorkOSVaultPluginOptions {
  readonly client?: WorkOSVaultClient;
  readonly credentials?: WorkOSVaultCredentials;
  readonly objectPrefix?: string;
  /**
   * Override the default scope-id → vault-context mapping. Each key
   * returned becomes an independent KEK-matching dimension, so hosts
   * whose scope ids have a non-default shape can split them into
   * meaningful fields (user/org/workspace/…) rather than a single
   * opaque string.
   */
  readonly contextForScope?: WorkOSVaultContextForScope;
}

const makeWorkOSVaultExtension = () =>
  ({
    providerKey: WORKOS_VAULT_PROVIDER_KEY,
  }) as const;

export type WorkOSVaultExtension = ReturnType<typeof makeWorkOSVaultExtension>;

// The plugin's typed store is just its metadata-store wrapper. The
// secret provider closes over this store plus the resolved WorkOS
// client; the scope id is threaded in per-call by the executor's
// secrets facade.
type WorkosVaultPluginStore = WorkosVaultStore;

const buildClient = (
  options: WorkOSVaultPluginOptions | undefined,
): Effect.Effect<WorkOSVaultClient, WorkOSVaultClientInstantiationError, never> => {
  if (options?.client) return Effect.succeed(options.client);
  if (options?.credentials) {
    return makeConfiguredWorkOSVaultClient(options.credentials);
  }
  return Effect.fail(
    new WorkOSVaultClientInstantiationError({
      cause: "workosVaultPlugin requires either `client` or `credentials` to be provided",
    }),
  );
};

export const workosVaultPlugin = definePlugin((options?: WorkOSVaultPluginOptions) => ({
  id: "workosVault" as const,
  packageName: "@executor-js/plugin-workos-vault",
  schema: workosVaultSchema,
  storage: (deps): WorkosVaultPluginStore => makeWorkosVaultStore(deps),

  extension: makeWorkOSVaultExtension,

  secretProviders: (ctx) => {
    // Build (or accept) the WorkOS client once at startup. If
    // credentials are bad this throws synchronously via Effect.runSync,
    // which is what we want — the executor fails to start rather
    // than surfacing bad credentials on first secret access.
    const client = Effect.runSync(buildClient(options));
    return [
      makeWorkOSVaultSecretProvider({
        client,
        store: ctx.storage,
        objectPrefix: options?.objectPrefix,
        contextForScope: options?.contextForScope,
      }),
    ];
  },
}));
