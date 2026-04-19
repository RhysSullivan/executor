import { Effect, Schema } from "effect";

import type { StorageFailure } from "@executor/storage-core";

import { SecretId, ScopeId } from "./ids";

// ---------------------------------------------------------------------------
// SecretProvider — what a concrete backend (keychain, 1password, file,
// memory, workos-vault, …) implements. Providers are contributed by
// plugins via `plugin.secretProviders` and registered in the executor
// at startup; there's no runtime registration.
//
// The `key` field is the provider's identifier in the secret table's
// `provider` column and in `executor.secrets.set(id, value, provider?)`.
// Unique per executor.
// ---------------------------------------------------------------------------

export interface SecretProvider {
  /** Unique key (e.g. "keychain", "env", "1password", "memory"). */
  readonly key: string;
  /** If false, `set` and `delete` are never called. The executor
   *  honours this before routing writes — trying to write to a
   *  read-only provider is an error, not a silent drop. */
  readonly writable: boolean;
  /** Get a secret value by id. Returns null if not found. Failures
   *  (provider unreachable, decryption failed, etc.) surface as
   *  `StorageFailure` — the executor treats a provider call the same
   *  as a DB call; `StorageError` is captured at the HTTP edge to
   *  `InternalError`, `UniqueViolationError` dies.
   *
   *  `scopeId` is the scope the caller wants to read at — the
   *  executor passes the winning scope from its core-table shadow
   *  pass so scope-aware backends (WorkOS Vault) can look in the
   *  right keyspace even when the executor's *write target* is a
   *  different scope. Providers that aren't scope-aware (keychain,
   *  env) ignore it. When unset, providers fall back to their
   *  construction-time scope (the write target). */
  readonly get: (
    id: string,
    scopeId?: string,
  ) => Effect.Effect<string | null, StorageFailure>;
  /** Set a secret value. Only called on writable providers.
   *  `scopeId`, when set, routes the write to a specific scope in
   *  the chain (the executor's current write target by default). */
  readonly set?: (
    id: string,
    value: string,
    scopeId?: string,
  ) => Effect.Effect<void, StorageFailure>;
  /** Delete a secret. Only called on writable providers. Returns true
   *  if something was deleted. `scopeId` routes the delete to a
   *  specific scope; defaults to the write target. */
  readonly delete?: (
    id: string,
    scopeId?: string,
  ) => Effect.Effect<boolean, StorageFailure>;
  /** Enumerate known secret entries. Optional — not all backends can
   *  enumerate (env-backed providers, for example). `scopeId` scopes
   *  the enumeration to one scope; when unset, the provider enumerates
   *  everything visible to the caller (its read chain). */
  readonly list?: (
    scopeId?: string,
  ) => Effect.Effect<
    readonly { readonly id: string; readonly name: string }[],
    StorageFailure
  >;
}

// ---------------------------------------------------------------------------
// SecretRef — metadata about a stored secret. Returned from
// `executor.secrets.list()`. The actual value lives in the provider
// and is only reachable via `executor.secrets.get(id)`.
// ---------------------------------------------------------------------------

export class SecretRef extends Schema.Class<SecretRef>("SecretRef")({
  id: SecretId,
  scopeId: ScopeId,
  /** Human-readable label (e.g. "Cloudflare API Token") */
  name: Schema.String,
  /** Which provider holds the value */
  provider: Schema.String,
  createdAt: Schema.DateFromNumber,
}) {}

// ---------------------------------------------------------------------------
// SetSecretInput — all the metadata to write a secret in one call.
// `executor.secrets.set(input)` takes this and writes both the
// value (to the provider) and the ref (to the `secret` table).
// ---------------------------------------------------------------------------

export class SetSecretInput extends Schema.Class<SetSecretInput>(
  "SetSecretInput",
)({
  id: SecretId,
  /** Display name shown in secret-list UI. */
  name: Schema.String,
  /** The secret value itself — never persisted outside the provider. */
  value: Schema.String,
  /** Optional provider routing. If unset the executor picks the first
   *  writable provider in registration order. */
  provider: Schema.optional(Schema.String),
}) {}
