import { Effect, Schema } from "effect";

import {
  definePlugin,
  type PluginCtx,
  type ScopedBlobStore,
  type SecretProvider,
} from "@executor/sdk";

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
  readonly getConfig: () => Effect.Effect<
    OnePasswordConfig | null,
    OnePasswordError
  >;

  /** Remove the 1Password configuration */
  readonly removeConfig: () => Effect.Effect<void, OnePasswordError>;

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
// Typed config store — single blob, JSON encoded. Declared inline because
// there's only one key and one document; a schema table would be overkill.
// ---------------------------------------------------------------------------

export interface OnePasswordStore {
  readonly getConfig: () => Effect.Effect<
    OnePasswordConfig | null,
    OnePasswordError
  >;
  readonly saveConfig: (
    config: OnePasswordConfig,
  ) => Effect.Effect<void, OnePasswordError>;
  readonly deleteConfig: () => Effect.Effect<void, OnePasswordError>;
}

const decodeConfig = Schema.decodeUnknownSync(OnePasswordConfig);

export const makeOnePasswordStore = (
  blobs: ScopedBlobStore,
): OnePasswordStore => ({
  getConfig: () =>
    blobs.get(CONFIG_KEY).pipe(
      Effect.mapError(
        (cause) =>
          new OnePasswordError({
            operation: "config load",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
      Effect.flatMap((raw) => {
        if (raw === null) return Effect.succeed(null);
        return Effect.try({
          try: () => decodeConfig(JSON.parse(raw)),
          catch: (cause) =>
            new OnePasswordError({
              operation: "config decode",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }),
    ),

  saveConfig: (config) =>
    blobs
      .put(
        CONFIG_KEY,
        JSON.stringify({
          auth: config.auth,
          vaultId: config.vaultId,
          name: config.name,
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new OnePasswordError({
              operation: "config save",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      ),

  deleteConfig: () =>
    blobs.delete(CONFIG_KEY).pipe(
      Effect.mapError(
        (cause) =>
          new OnePasswordError({
            operation: "config delete",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    ),
});

// ---------------------------------------------------------------------------
// Helpers — auth resolution + service construction
// ---------------------------------------------------------------------------

const resolveAuth = (
  auth: OnePasswordAuth,
  ctx: PluginCtx<OnePasswordStore>,
): Effect.Effect<ResolvedAuth, OnePasswordError> => {
  if (auth.kind === "desktop-app") {
    return Effect.succeed({
      kind: "desktop-app" as const,
      accountName: auth.accountName,
    });
  }
  return ctx.secrets.get(auth.tokenSecretId).pipe(
    Effect.mapError(
      (cause) =>
        new OnePasswordError({
          operation: "auth resolution",
          message: `Failed to resolve service account token secret "${auth.tokenSecretId}": ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
    Effect.flatMap((token) => {
      if (token === null) {
        return Effect.fail(
          new OnePasswordError({
            operation: "auth resolution",
            message: `Service account token secret "${auth.tokenSecretId}" not found`,
          }),
        );
      }
      return Effect.succeed({
        kind: "service-account" as const,
        token,
      });
    }),
  );
};

const getServiceFromConfig = (
  config: OnePasswordConfig,
  ctx: PluginCtx<OnePasswordStore>,
  timeoutMs: number,
  preferSdk: boolean | undefined,
): Effect.Effect<OnePasswordService, OnePasswordError> =>
  resolveAuth(config.auth, ctx).pipe(
    Effect.flatMap((resolved) =>
      makeOnePasswordService(resolved, { timeoutMs, preferSdk }),
    ),
  );

// ---------------------------------------------------------------------------
// SecretProvider — read-only, resolves op:// URIs or vaultId-based lookups
// ---------------------------------------------------------------------------

const makeProvider = (
  ctx: PluginCtx<OnePasswordStore>,
  timeoutMs: number,
  preferSdk: boolean | undefined,
): SecretProvider => ({
  key: "onepassword",
  writable: false,

  get: (secretId) =>
    ctx.storage.getConfig().pipe(
      Effect.flatMap((config) => {
        if (!config) return Effect.succeed(null as string | null);

        const uri = secretId.startsWith("op://")
          ? secretId
          : `op://${config.vaultId}/${secretId}/${CREDENTIAL_FIELD}`;

        return getServiceFromConfig(config, ctx, timeoutMs, preferSdk).pipe(
          Effect.flatMap((svc) => svc.resolveSecret(uri)),
          Effect.map((v): string | null => v),
          Effect.orElseSucceed(() => null),
        );
      }),
      Effect.orElseSucceed(() => null),
    ),

  list: () =>
    ctx.storage.getConfig().pipe(
      Effect.flatMap((config) => {
        if (!config)
          return Effect.succeed(
            [] as ReadonlyArray<{ id: string; name: string }>,
          );
        return getServiceFromConfig(config, ctx, timeoutMs, preferSdk).pipe(
          Effect.flatMap((svc) => svc.listItems(config.vaultId)),
          Effect.map(
            (items): ReadonlyArray<{ id: string; name: string }> =>
              items.map((item) => ({ id: item.id, name: item.title })),
          ),
        );
      }),
      Effect.orElseSucceed(
        () => [] as ReadonlyArray<{ id: string; name: string }>,
      ),
    ),
});

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface OnePasswordPluginOptions {
  /** Request timeout in ms (default: 15000) */
  readonly timeoutMs?: number;
  /** Force use of the native SDK instead of the CLI (default: false) */
  readonly preferSdk?: boolean;
}

export const onepasswordPlugin = definePlugin(
  (options?: OnePasswordPluginOptions) => {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const preferSdk = options?.preferSdk;

    return {
      id: "onepassword" as const,
      storage: ({ blobs }) => makeOnePasswordStore(blobs),

      extension: (ctx): OnePasswordExtension => ({
        configure: (config) => ctx.storage.saveConfig(config),

        getConfig: () => ctx.storage.getConfig(),

        removeConfig: () => ctx.storage.deleteConfig(),

        status: () =>
          Effect.gen(function* () {
            const config = yield* ctx.storage.getConfig();
            if (!config) {
              return new ConnectionStatus({
                connected: false,
                error: "Not configured",
              });
            }
            const svc = yield* getServiceFromConfig(
              config,
              ctx,
              timeoutMs,
              preferSdk,
            );
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
              preferSdk,
            });
            const vaults = yield* svc.listVaults();
            return vaults
              .map((v) => new Vault({ id: v.id, name: v.title }))
              .sort((a, b) => a.name.localeCompare(b.name));
          }),

        resolve: (uri) =>
          Effect.gen(function* () {
            const config = yield* ctx.storage.getConfig();
            if (!config) {
              return yield* Effect.fail(
                new OnePasswordError({
                  operation: "resolve",
                  message: "1Password is not configured",
                }),
              );
            }
            const svc = yield* getServiceFromConfig(
              config,
              ctx,
              timeoutMs,
              preferSdk,
            );
            return yield* svc.resolveSecret(uri);
          }),
      }),

      secretProviders: (ctx) => [makeProvider(ctx, timeoutMs, preferSdk)],
    };
  },
);
