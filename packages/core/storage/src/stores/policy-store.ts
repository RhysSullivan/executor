import type { Effect } from "effect";

import type { PolicyId, ScopeId } from "../ids";
import type { Policy } from "../policies";

// ---------------------------------------------------------------------------
// Row types — structural intermediates for policy persistence.
// ---------------------------------------------------------------------------

export interface PolicyRow {
  readonly id: string;
  readonly scopeId: string;
  readonly name: string;
  readonly action: string;
  readonly matchToolPattern: string | null;
  readonly matchSourceId: string | null;
  readonly priority: number;
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// PolicyStore — repository interface
// ---------------------------------------------------------------------------

export interface PolicyStore {
  /** Find all policies for a given scope. */
  readonly findByScope: (scopeId: ScopeId) => Effect.Effect<readonly Policy[]>;

  /** Create a new policy. */
  readonly create: (policy: Policy) => Effect.Effect<void>;

  /** Delete a policy by id within a scope. Returns true if the row existed. */
  readonly deleteById: (id: PolicyId, scopeId: ScopeId) => Effect.Effect<boolean>;
}
