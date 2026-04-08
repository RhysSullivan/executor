import { Effect, Schema } from "effect";

import {
  definePlugin,
  type ExecutorPlugin,
  type PluginContext,
  type SecretProvider,
  type ScopedKv,
  SecretId,
} from "@executor/core";

import { OnePasswordConfig, Vault, ConnectionStatus } from "./types";
import type { OnePasswordAuth } from "./types";
import { OnePasswordError } from "./errors";
import {
  makeOnePasswordService,
  type ResolvedAuth,
  type OnePasswordService,
} from "./service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_KEY = "onepassword";
const CREDENTIAL_FIELD = "credential";
const DEFAULT_TIMEOUT_MS = 15_000;
const CONFIG_KEY = "config";

// ---------------------------------------------------------------------------
// Plugin extension — public API on executor.onepassword
// ---------------------------------------------------------------------------

export interface OnePasswordExtension {
  /** Configure the 1Password connection */
  readonly configure: (
    config: OnePasswordConfig,
  ) => Effect.Effect<void, OnePasswordError>;

  /** Get current configuration (if any) */
  readonly getConfig: () => Effect.Effect<OnePasswordConfig | null, OnePasswordError>;

  /** Remove the 1Password configuration */
  readonly removeConfig: () => Effect.Effect<void>;

  /** Check connection status */
  readonly status: () => Effect.Effect<ConnectionStatus, OnePasswordError>;

  /** List accessible vaults (requires auth) */
  readonly listVaults: (
    auth: OnePasswordAuth,
  ) => Effect.Effect<ReadonlyArray<Vault>, OnePasswordError>;

  /** Resolve a secret directly by op:// URI */
  readonly resolve: (uri: string) => Effect.Effect<string, OnePasswordError>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolveAuth = (
  auth: OnePasswordAuth,
  ctx: PluginContext,
): Effect.Effect<ResolvedAuth, OnePasswordError> => {
  if (auth.kind === "desktop-app") {
    return Effect.succeed({
      kind: "desktop-app" as const,
      accountName: auth.accountName,
    });
  }
  return ctx.secrets.resolve(SecretId.make(auth.tokenSecretId), ctx.scope.id).pipe(
    Effect.map(
      (token): ResolvedAuth => ({ kind: "service-account", token }),
    ),
    Effect.mapError(
      (e) =>
        new OnePasswordError({
          operation: "auth resolution",
          message: `Failed to resolve service account token secret "${auth.tokenSecretId}": ${e._tag}`,
        }),
    ),
  );
};

const getServiceFromConfig = (
  config: OnePasswordConfig,
  ctx: PluginContext,
  timeoutMs: number,
): Effect.Effect<OnePasswordService, OnePasswordError> =>
  resolveAuth(config.auth, ctx).pipe(
    Effect.flatMap((resolved) => makeOnePasswordService(resolved, { timeoutMs })),
  );

// ---------------------------------------------------------------------------
// SecretProvider — read-only, resolves op:// URIs or vaultId-based lookups
// ---------------------------------------------------------------------------

const makeProvider = (
  getConfig: () => Effect.Effect<OnePasswordConfig | null, OnePasswordError>,
  ctx: PluginContext,
  timeoutMs: number,
): SecretProvider => ({
  key: "onepassword",
  writable: false,

  get: (secretId) =>
    getConfig().pipe(
      Effect.flatMap((config) => {
        if (!config) return Effect.succeed(null);

        const uri = secretId.startsWith("op://")
          ? secretId
          : `op://${config.vaultId}/${secretId}/${CREDENTIAL_FIELD}`;

        return getServiceFromConfig(config, ctx, timeoutMs).pipe(
          Effect.flatMap((svc) => svc.resolveSecret(uri)),
          Effect.map((v): string | null => v),
          Effect.orElseSucceed(() => null),
        );
      }),
      Effect.orElseSucceed(() => null),
    ),

  list: () =>
    getConfig().pipe(
      Effect.flatMap((config) => {
        if (!config) return Effect.succeed([] as { id: string; name: string }[]);
        return getServiceFromConfig(config, ctx, timeoutMs).pipe(
          Effect.flatMap((svc) => svc.listItems(config.vaultId)),
          Effect.map((items) =>
            items.map((item) => ({ id: item.id, name: item.title })),
          ),
        );
      }),
      Effect.orElseSucceed(() => [] as { id: string; name: string }[]),
    ),
});

// ---------------------------------------------------------------------------
// Config persistence via ScopedKv
// ---------------------------------------------------------------------------

const decodeConfig = Schema.decodeUnknownSync(OnePasswordConfig);

const loadConfig = (kv: ScopedKv): Effect.Effect<OnePasswordConfig | null, OnePasswordError> =>
  kv.get(CONFIG_KEY).pipe(
    Effect.flatMap((v) => {
      if (v === null) return Effect.succeed(null);
      return Effect.try(() => decodeConfig(JSON.parse(v))).pipe(
        Effect.mapError(
          (cause) =>
            new OnePasswordError({
              operation: "config decode",
              message:
                cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      );
    }),
  );

const saveConfig = (
  kv: ScopedKv,
  config: OnePasswordConfig,
): Effect.Effect<void> =>
  kv.set(CONFIG_KEY, JSON.stringify({
    auth: config.auth,
    vaultId: config.vaultId,
    name: config.name,
  }));

const deleteConfig = (kv: ScopedKv): Effect.Effect<void> => kv.delete(CONFIG_KEY);

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface OnePasswordPluginOptions {
  /** Scoped KV for persisting config (provided by server) */
  readonly kv: ScopedKv;
  /** Request timeout in ms (default: 15000) */
  readonly timeoutMs?: number;
  /** Force use of the native SDK instead of the CLI (default: false) */
  readonly preferSdk?: boolean;
}

export const onepasswordPlugin = (
  options: OnePasswordPluginOptions,
): ExecutorPlugin<typeof PLUGIN_KEY, OnePasswordExtension> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const kv = options.kv;

  return definePlugin({
    key: PLUGIN_KEY,
    init: (ctx) =>
      Effect.gen(function* () {
        const getConfig = () => loadConfig(kv);

        yield* ctx.secrets.addProvider(
          makeProvider(getConfig, ctx, timeoutMs),
        );

        const extension: OnePasswordExtension = {
          configure: (config) =>
            saveConfig(kv, config),

          getConfig: () => getConfig(),

          removeConfig: () => deleteConfig(kv),

          status: () =>
            Effect.gen(function* () {
              const config = yield* getConfig();
              if (!config) {
                return new ConnectionStatus({
                  connected: false,
                  error: "Not configured",
                });
              }
              const svc = yield* getServiceFromConfig(config, ctx, timeoutMs);
              const vaults = yield* svc.listVaults();
              const vault = vaults.find((v) => v.id === config.vaultId);
              return new ConnectionStatus({
                connected: true,
                vaultName: vault?.title,
              });
            }),

          listVaults: (auth) =>
            Effect.gen(function* () {
              const resolved = yield* resolveAuth(auth, ctx);
              const svc = yield* makeOnePasswordService(resolved, {
                timeoutMs,
                preferSdk: options.preferSdk,
              });
              const vaults = yield* svc.listVaults();
              return vaults
                .map((v) => new Vault({ id: v.id, name: v.title }))
                .sort((a, b) => a.name.localeCompare(b.name));
            }),

          resolve: (uri) =>
            Effect.gen(function* () {
              const config = yield* getConfig();
              if (!config) {
                return yield* new OnePasswordError({
                  operation: "resolve",
                  message: "1Password is not configured",
                });
              }
              const svc = yield* getServiceFromConfig(config, ctx, timeoutMs);
              return yield* svc.resolveSecret(uri);
            }),
        };

        return { extension };
      }),
  });
};
