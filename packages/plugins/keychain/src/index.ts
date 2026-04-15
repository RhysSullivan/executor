import { Effect } from "effect";

import { definePlugin, type PluginCtx } from "@executor/sdk";

import { displayName, isSupportedPlatform, resolveServiceName } from "./keyring";
import { getPassword } from "./keyring";
import { makeKeychainProvider } from "./provider";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { KeychainError } from "./errors";
export { makeKeychainProvider } from "./provider";
export { isSupportedPlatform, displayName } from "./keyring";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export interface KeychainPluginConfig {
  /** Override the keychain service name (default: "executor") */
  readonly serviceName?: string;
}

// ---------------------------------------------------------------------------
// Plugin extension — public API on executor.keychain
// ---------------------------------------------------------------------------

export interface KeychainExtension {
  /** Human-readable name for the keychain on this platform */
  readonly displayName: string;

  /** Whether the current platform supports system keychain */
  readonly isSupported: boolean;

  /** Check if a secret exists in the system keychain */
  readonly has: (id: string) => Effect.Effect<boolean>;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

// Scope the keychain service name to the current executor scope so each
// folder / workspace gets its own set of keychain entries. Computed
// identically in `extension` and `secretProviders` — both receive ctx and
// both are called once per createExecutor, so the derivation stays pure.
const scopedServiceName = (
  ctx: PluginCtx<unknown>,
  options: KeychainPluginConfig | undefined,
): string =>
  `${resolveServiceName(options?.serviceName)}/${ctx.scope.id}`;

export const keychainPlugin = definePlugin(
  (options?: KeychainPluginConfig) => ({
    id: "keychain" as const,
    storage: () => ({}),

    extension: (ctx): KeychainExtension => {
      const serviceName = scopedServiceName(ctx, options);
      return {
        displayName: displayName(),
        isSupported: isSupportedPlatform(),
        has: (id) =>
          getPassword(serviceName, id).pipe(
            Effect.map((v) => v !== null),
            Effect.orElseSucceed(() => false),
          ),
      };
    },

    secretProviders: (ctx) => [
      makeKeychainProvider(scopedServiceName(ctx, options)),
    ],
  }),
);
