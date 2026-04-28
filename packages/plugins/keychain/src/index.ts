import { Effect } from "effect";

import { definePlugin, type PluginCtx } from "@executor/sdk";

import {
  deletePassword,
  displayName,
  getPassword,
  isSupportedPlatform,
  resolveServiceName,
  setPassword,
} from "./keyring";
import { makeKeychainProvider } from "./provider";

// Probe the keychain by writing and then deleting a sentinel entry. A
// read-only probe isn't enough — on some Linux environments (WSL2,
// headless CI) `getPassword` for a missing key returns null without
// error, but `setPassword` fails because the secret-service backend
// isn't actually reachable. Writing is the capability the executor
// cares about, so test it directly.
const PROBE_ACCOUNT = "__executor_keychain_probe__";
const PROBE_VALUE = "probe";

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
  `${resolveServiceName(options?.serviceName)}/${ctx.scopes[0]!.id as string}`;

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

    secretProviders: (ctx) =>
      Effect.gen(function* () {
        const serviceName = scopedServiceName(ctx, options);
        const reachable = yield* setPassword(
          serviceName,
          PROBE_ACCOUNT,
          PROBE_VALUE,
        ).pipe(
          Effect.andThen(
            deletePassword(serviceName, PROBE_ACCOUNT).pipe(
              Effect.catchAll(() => Effect.void),
            ),
          ),
          Effect.as(true),
          Effect.catchAll((cause) =>
            Effect.logWarning(
              `keychain unavailable, skipping provider registration: ${cause.message}`,
            ).pipe(Effect.as(false)),
          ),
        );
        return reachable ? [makeKeychainProvider(serviceName)] : [];
      }),
  }),
);
