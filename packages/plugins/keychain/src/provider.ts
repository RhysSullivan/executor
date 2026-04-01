import { Effect } from "effect";

import type { SecretProvider } from "@executor/sdk";

import { getPassword, setPassword, deletePassword } from "./keyring";

// ---------------------------------------------------------------------------
// SecretProvider adapter — bridges keyring into SDK resolution chain
// ---------------------------------------------------------------------------

export const makeKeychainProvider = (serviceName: string): SecretProvider => ({
  key: "keychain",
  writable: true,
  get: (secretId) =>
    getPassword(serviceName, secretId).pipe(
      Effect.orElseSucceed(() => null),
    ),
  set: (secretId, value) =>
    setPassword(serviceName, secretId, value).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  delete: (secretId) =>
    deletePassword(serviceName, secretId).pipe(
      Effect.orElseSucceed(() => false),
    ),
  // Keychain doesn't support enumerating — you need to know the account name
  list: undefined,
});
