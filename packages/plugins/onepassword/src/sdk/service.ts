import { Context, Duration, Effect } from "effect";
import * as op from "@1password/op-js";

import { OnePasswordError } from "./errors";

// ---------------------------------------------------------------------------
// Canonical service interface — all backends (SDK, CLI) implement this
// ---------------------------------------------------------------------------

export interface OnePasswordVault {
  readonly id: string;
  readonly title: string;
}

export interface OnePasswordItem {
  readonly id: string;
  readonly title: string;
}

export interface OnePasswordService {
  /** Resolve a secret by op:// URI */
  readonly resolveSecret: (uri: string) => Effect.Effect<string, OnePasswordError>;

  /** List accessible vaults */
  readonly listVaults: () => Effect.Effect<ReadonlyArray<OnePasswordVault>, OnePasswordError>;

  /** List items in a vault */
  readonly listItems: (
    vaultId: string,
  ) => Effect.Effect<ReadonlyArray<OnePasswordItem>, OnePasswordError>;
}

export class OnePasswordServiceTag extends Context.Tag(
  "@executor/plugin-onepassword/OnePasswordService",
)<OnePasswordServiceTag, OnePasswordService>() {}

// ---------------------------------------------------------------------------
// Resolved auth — raw credentials ready for any backend
// ---------------------------------------------------------------------------

export type ResolvedAuth =
  | { readonly kind: "desktop-app"; readonly accountName: string }
  | { readonly kind: "service-account"; readonly token: string };

// ---------------------------------------------------------------------------
// SDK backend — uses @1password/sdk native IPC
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;
type OnePasswordSdkModule = typeof import("@1password/sdk");

const loadOnePasswordSdk = (): Effect.Effect<OnePasswordSdkModule, OnePasswordError> =>
  Effect.tryPromise({
    try: () => import("@1password/sdk"),
    catch: (cause) =>
      new OnePasswordError({
        operation: "sdk module load",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const makeTimeoutMessage = (operation: string, timeoutMs: number): string =>
  [
    `${operation}: timed out after ${Math.floor(timeoutMs / 1000)}s.`,
    "Troubleshooting:",
    "1. Make sure the 1Password desktop app is open and unlocked",
    "2. Check for an approval prompt in the 1Password app — it may be behind other windows",
    "3. Ensure 'Developer > Connect with 1Password CLI' is enabled in 1Password Settings",
    "4. Make sure no other app or terminal is waiting for 1Password approval (only one prompt at a time)",
    "5. Try quitting 1Password completely and reopening it, then retry",
  ].join("\n");

export const makeNativeSdkService = (
  auth: ResolvedAuth,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Effect.Effect<OnePasswordService, OnePasswordError> =>
  Effect.gen(function* () {
    const timeout = Duration.millis(timeoutMs);
    const sdk = yield* loadOnePasswordSdk().pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () =>
          new OnePasswordError({
            operation: "sdk module load",
            message: makeTimeoutMessage("sdk module load", timeoutMs),
          }),
      }),
    );

    const client = yield* Effect.tryPromise({
      try: () =>
        sdk.createClient({
          auth: auth.kind === "desktop-app" ? new sdk.DesktopAuth(auth.accountName) : auth.token,
          integrationName: "Executor",
          integrationVersion: "0.0.0",
        }),
      catch: (cause) =>
        new OnePasswordError({
          operation: "client setup",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () =>
          new OnePasswordError({
            operation: "client setup",
            message: makeTimeoutMessage("client setup", timeoutMs),
          }),
      }),
    );

    const wrap = <A>(fn: () => Promise<A>, operation: string): Effect.Effect<A, OnePasswordError> =>
      Effect.tryPromise({
        try: fn,
        catch: (cause) =>
          new OnePasswordError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }).pipe(
        Effect.timeoutFail({
          duration: timeout,
          onTimeout: () =>
            new OnePasswordError({
              operation,
              message: makeTimeoutMessage(operation, timeoutMs),
            }),
        }),
        Effect.withSpan(`onepassword.sdk.${operation}`),
      );

    return OnePasswordServiceTag.of({
      resolveSecret: (uri) => wrap(() => client.secrets.resolve(uri), "secret resolution"),

      listVaults: () =>
        wrap(() => client.vaults.list({ decryptDetails: true }), "vault listing").pipe(
          Effect.map((vaults) => vaults.map((v) => ({ id: v.id, title: v.title }))),
        ),

      listItems: (vaultId) =>
        wrap(() => client.items.list(vaultId), "item listing").pipe(
          Effect.map((items) => items.map((i) => ({ id: i.id, title: i.title }))),
        ),
    });
  }).pipe(Effect.withSpan("onepassword.sdk.make_service"));

// ---------------------------------------------------------------------------
// CLI backend — uses @1password/op-js (shells out to `op` CLI)
// ---------------------------------------------------------------------------

export const makeCliService = (
  auth: ResolvedAuth,
): Effect.Effect<OnePasswordService, OnePasswordError> =>
  Effect.gen(function* () {
    // Configure auth
    if (auth.kind === "service-account") {
      op.setServiceAccount(auth.token);
    } else {
      op.setGlobalFlags({ account: auth.accountName });
    }

    const wrapSync = <A>(fn: () => A, operation: string): Effect.Effect<A, OnePasswordError> =>
      Effect.try({
        try: fn,
        catch: (cause) =>
          new OnePasswordError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }).pipe(Effect.withSpan(`onepassword.cli.${operation}`));

    return OnePasswordServiceTag.of({
      resolveSecret: (uri) => wrapSync(() => op.read.parse(uri), "secret resolution"),

      listVaults: () =>
        wrapSync(() => op.vault.list(), "vault listing").pipe(
          Effect.map((vaults) => vaults.map((v) => ({ id: v.id, title: v.name }))),
        ),

      listItems: (vaultId) =>
        wrapSync(() => op.item.list({ vault: vaultId }), "item listing").pipe(
          Effect.map((items) => items.map((i) => ({ id: i.id, title: i.title }))),
        ),
    });
  }).pipe(Effect.withSpan("onepassword.cli.make_service"));

// ---------------------------------------------------------------------------
// Smart factory — tries CLI first (avoids IPC hang), falls back to SDK
// ---------------------------------------------------------------------------

export const makeOnePasswordService = (
  auth: ResolvedAuth,
  options?: { readonly preferSdk?: boolean; readonly timeoutMs?: number },
): Effect.Effect<OnePasswordService, OnePasswordError> => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (options?.preferSdk) {
    return makeNativeSdkService(auth, timeoutMs);
  }

  // Default: prefer CLI to avoid the IPC hang bug
  return makeCliService(auth).pipe(
    Effect.catchAll((cliError) =>
      // CLI unavailable (e.g. `op` not installed) — fall back to SDK
      makeNativeSdkService(auth, timeoutMs).pipe(Effect.mapError(() => cliError)),
    ),
  );
};
