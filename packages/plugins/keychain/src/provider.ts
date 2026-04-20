import { Effect } from "effect";

import { StorageError, type SecretProvider } from "@executor/sdk";

import { getPassword, setPassword, deletePassword } from "./keyring";

// ---------------------------------------------------------------------------
// SecretProvider adapter — bridges keyring into SDK resolution chain
//
// The underlying `@napi-rs/keyring` sync API encodes "no entry" as an
// ordinary return value (`getPassword()` → `null`, `deletePassword()` →
// `false`), and only throws on real failures (keychain locked, permission
// denied, platform init failure, etc.). `keyring.ts` wraps those thrown
// failures as `KeychainError`. We translate `KeychainError` →
// `StorageError` so the HTTP edge can capture it to telemetry and surface
// an opaque `InternalError({ traceId })` — previously `orElseSucceed`
// silently converted every failure into "nothing found", which made it
// impossible to debug why secrets weren't resolving.
// ---------------------------------------------------------------------------

const toStorageError = (cause: { readonly message: string; readonly cause?: unknown }) =>
  new StorageError({ message: cause.message, cause: cause.cause ?? cause });

// Scope arg is ignored — keychain partitions by `serviceName`, which the
// host fixes per executor at construction time. A future refactor could
// fold `scope` into the service name, but today a keychain provider
// instance is already one-scope.
export const makeKeychainProvider = (serviceName: string): SecretProvider => ({
  key: "keychain",
  writable: true,
  get: (secretId, _scope) =>
    getPassword(serviceName, secretId).pipe(Effect.mapError(toStorageError)),
  set: (secretId, value, _scope) =>
    setPassword(serviceName, secretId, value).pipe(Effect.mapError(toStorageError)),
  delete: (secretId, _scope) =>
    deletePassword(serviceName, secretId).pipe(Effect.mapError(toStorageError)),
  // Keychain doesn't support enumerating — you need to know the account name
  list: undefined,
});
