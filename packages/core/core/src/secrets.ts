import { Context, Effect, Schema } from "effect";

import { SecretId, ScopeId } from "./ids";
import { SecretNotFoundError, SecretResolutionError } from "./errors";

// ---------------------------------------------------------------------------
// SecretProvider — adapter interface for secret backends
// ---------------------------------------------------------------------------

export interface SecretProvider {
  /** Unique key (e.g. "keychain", "env", "1password", "memory") */
  readonly key: string;
  /** Whether this provider supports writing */
  readonly writable: boolean;
  /** Get a secret value by key. Returns null if not found. */
  readonly get: (key: string) => Effect.Effect<string | null>;
  /** Set a secret value. Only called on writable providers. */
  readonly set?: (key: string, value: string) => Effect.Effect<void>;
  /** Delete a secret. Only called on writable providers. */
  readonly delete?: (key: string) => Effect.Effect<boolean>;
  /** List known secret entries. Optional — not all providers can enumerate. */
  readonly list?: () => Effect.Effect<readonly { id: string; name: string }[]>;
}

// ---------------------------------------------------------------------------
// SecretRef — what gets stored (not the value itself)
// ---------------------------------------------------------------------------

export class SecretRef extends Schema.Class<SecretRef>("SecretRef")({
  id: SecretId,
  scopeId: ScopeId,
  /** Human-readable label (e.g. "Cloudflare API Token") */
  name: Schema.String,
  /** Optional: pin to a specific provider */
  provider: Schema.optionalWith(Schema.String, { as: "Option" }),
  /** What this secret is for */
  purpose: Schema.optional(Schema.String),
  createdAt: Schema.DateFromNumber,
}) {}

// ---------------------------------------------------------------------------
// SetSecretInput — SecretRef fields minus createdAt, plus value
// ---------------------------------------------------------------------------

export class SetSecretInput extends Schema.Class<SetSecretInput>("SetSecretInput")({
  id: SecretId,
  scopeId: ScopeId,
  name: Schema.String,
  value: Schema.String,
  provider: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// SecretStore — manages refs + delegates resolution to providers
// ---------------------------------------------------------------------------

export class SecretStore extends Context.Tag("@executor/sdk/SecretStore")<
  SecretStore,
  {
    /** List all secret refs for a scope */
    readonly list: (scopeId: ScopeId) => Effect.Effect<readonly SecretRef[]>;

    /** Get a specific secret ref by id */
    readonly get: (
      secretId: SecretId,
    ) => Effect.Effect<SecretRef, SecretNotFoundError>;

    /**
     * Resolve a secret value by id.
     * Walks the provider chain (and optionally scope chain) to find the value.
     */
    readonly resolve: (
      secretId: SecretId,
      scopeId: ScopeId,
    ) => Effect.Effect<string, SecretNotFoundError | SecretResolutionError>;

    /**
     * Check if a secret can be resolved.
     */
    readonly status: (
      secretId: SecretId,
      scopeId: ScopeId,
    ) => Effect.Effect<"resolved" | "missing">;

    /**
     * Store a secret value. Creates a ref and writes the value to the
     * preferred writable provider.
     */
    readonly set: (input: SetSecretInput) => Effect.Effect<SecretRef, SecretResolutionError>;


    /** Remove a secret ref and its value from the provider */
    readonly remove: (
      secretId: SecretId,
    ) => Effect.Effect<boolean, SecretNotFoundError>;

    // ----- Provider management -----

    /** Register a secret provider */
    readonly addProvider: (provider: SecretProvider) => Effect.Effect<void>;

    /** List registered provider keys */
    readonly providers: () => Effect.Effect<readonly string[]>;
  }
>() {}
