import { Effect } from "effect";

import { KeychainError } from "./errors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SERVICE_NAME = "executor";
const SERVICE_NAME_ENV = "EXECUTOR_KEYCHAIN_SERVICE_NAME";

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

export const isSupportedPlatform = () =>
  process.platform === "darwin" ||
  process.platform === "linux" ||
  process.platform === "win32";

export const displayName = () =>
  process.platform === "darwin"
    ? "macOS Keychain"
    : process.platform === "win32"
      ? "Windows Credential Manager"
      : "Desktop Keyring";

export const resolveServiceName = (explicit?: string): string =>
  explicit?.trim() || process.env[SERVICE_NAME_ENV]?.trim() || DEFAULT_SERVICE_NAME;

// ---------------------------------------------------------------------------
// Lazy-load @napi-rs/keyring (native module)
// ---------------------------------------------------------------------------

type EntryConstructor = (typeof import("@napi-rs/keyring"))["Entry"];

let entryCtorPromise: Promise<EntryConstructor> | null = null;

const loadEntry = (): Effect.Effect<EntryConstructor, KeychainError> =>
  Effect.tryPromise({
    try: async () => {
      if (!isSupportedPlatform()) {
        throw new Error(`unsupported platform '${process.platform}'`);
      }
      entryCtorPromise ??= import("@napi-rs/keyring").then(({ Entry }) => Entry);
      return await entryCtorPromise;
    },
    catch: (cause) =>
      new KeychainError({
        message: `Failed loading native keyring: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

const createEntry = (serviceName: string, account: string) =>
  Effect.flatMap(loadEntry(), (Entry) =>
    Effect.try({
      try: () => new Entry(serviceName, account),
      catch: (cause) =>
        new KeychainError({
          message: `Failed creating keyring entry: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    }),
  );

// ---------------------------------------------------------------------------
// Low-level keychain operations
// ---------------------------------------------------------------------------

export const getPassword = (
  serviceName: string,
  account: string,
): Effect.Effect<string | null, KeychainError> =>
  Effect.flatMap(createEntry(serviceName, account), (entry) =>
    Effect.try({
      try: () => entry.getPassword(),
      catch: () => new KeychainError({ message: `Failed reading secret for account '${account}'` }),
    }),
  );

export const setPassword = (
  serviceName: string,
  account: string,
  value: string,
): Effect.Effect<void, KeychainError> =>
  Effect.flatMap(createEntry(serviceName, account), (entry) =>
    Effect.try({
      try: () => entry.setPassword(value),
      catch: (cause) =>
        new KeychainError({
          message: `Failed writing secret: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    }).pipe(Effect.asVoid),
  );

export const deletePassword = (
  serviceName: string,
  account: string,
): Effect.Effect<boolean, KeychainError> =>
  Effect.flatMap(createEntry(serviceName, account), (entry) =>
    Effect.try({
      try: () => {
        entry.deletePassword();
        return true;
      },
      catch: () => new KeychainError({ message: `Failed deleting secret for account '${account}'` }),
    }),
  );
