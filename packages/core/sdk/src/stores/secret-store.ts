import type { Effect } from "effect";

import type { SecretId, ScopeId } from "../ids";

// ---------------------------------------------------------------------------
// Row types — structural intermediates for secret persistence.
// ---------------------------------------------------------------------------

export interface SecretRow {
  readonly id: string;
  readonly scopeId: string;
  readonly name: string;
  readonly purpose: string | null;
  readonly provider: string | null;
  readonly encryptedValue: Uint8Array | null;
  readonly iv: Uint8Array | null;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// SecretStore — repository interface (distinct from the SecretManager Tag)
//
// Pure CRUD. No crypto — encryption/decryption lives in services/secret-manager.ts.
// ---------------------------------------------------------------------------

export interface SecretStore {
  /** Find a single secret row by id within a scope. Returns null if not found. */
  readonly findById: (id: SecretId, scopeId: ScopeId) => Effect.Effect<SecretRow | null>;

  /** Find all secret rows for a given scope. */
  readonly findByScope: (scopeId: ScopeId) => Effect.Effect<readonly SecretRow[]>;

  /** Upsert a secret row (row includes scopeId inline). */
  readonly upsert: (row: SecretRow) => Effect.Effect<void>;

  /** Delete a secret by id within a scope. Returns true if the row existed. */
  readonly deleteById: (id: SecretId, scopeId: ScopeId) => Effect.Effect<boolean>;
}
