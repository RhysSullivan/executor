import { Effect } from "effect";

import {
  definePlugin,
  type SecretId,
  type ExecutorPlugin,
} from "@executor/sdk";

import { displayName, isSupportedPlatform, resolveServiceName } from "./keyring";
import { getPassword } from "./keyring";
import { makeKeychainProvider } from "./provider";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { KeychainError } from "./errors";
export { makeKeychainProvider } from "./provider";

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
  readonly has: (secretId: SecretId) => Effect.Effect<boolean>;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const PLUGIN_KEY = "keychain";

export const keychainPlugin = (
  config?: KeychainPluginConfig,
): ExecutorPlugin<typeof PLUGIN_KEY, KeychainExtension> => {
  const serviceName = resolveServiceName(config?.serviceName);

  return definePlugin({
    key: PLUGIN_KEY,
    init: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.secrets.addProvider(makeKeychainProvider(serviceName));

        const extension: KeychainExtension = {
          displayName: displayName(),
          isSupported: isSupportedPlatform(),

          has: (secretId) =>
            getPassword(serviceName, secretId).pipe(
              Effect.map((v) => v !== null),
              Effect.orElseSucceed(() => false),
            ),
        };

        return { extension };
      }),
  });
};
