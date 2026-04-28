import { createRequire } from "node:module";

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
  process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";

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

// In compiled bun binaries (`bun build --compile`) `.node` modules aren't
// included in bunfs and there's no node_modules at runtime, so
// @napi-rs/keyring's loader can't find its platform-specific binding.
// `apps/cli/src/build.ts` copies the .node next to the executor and
// `apps/cli/src/main.ts` exports its absolute path here. We load it
// directly because @napi-rs/keyring@1.2.0's NAPI_RS_NATIVE_LIBRARY_PATH
// branch is buggy (assigns to a local that gets overwritten before return).
const loadEntryCtor = async (): Promise<EntryConstructor> => {
  const directPath = process.env.EXECUTOR_KEYRING_NATIVE_PATH;
  if (directPath) {
    const req = createRequire(import.meta.url);
    return (req(directPath) as { Entry: EntryConstructor }).Entry;
  }
  const { Entry } = await import("@napi-rs/keyring");
  return Entry;
};

const loadEntry = (): Effect.Effect<EntryConstructor, KeychainError> =>
  Effect.tryPromise({
    try: async () => {
      if (!isSupportedPlatform()) {
        throw new Error(`unsupported platform '${process.platform}'`);
      }
      entryCtorPromise ??= loadEntryCtor();
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
      catch: () =>
        new KeychainError({ message: `Failed deleting secret for account '${account}'` }),
    }),
  );
