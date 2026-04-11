import type { Effect } from "effect";

import type { ToolId, ScopeId } from "../ids";
import type { ToolRegistration } from "../tools";

// ---------------------------------------------------------------------------
// Row types — structural intermediates for tool persistence.
// The `$inferSelect` result from either pg-core or sqlite-core is assignable
// to these types.
// ---------------------------------------------------------------------------

export interface ToolRow {
  readonly id: string;
  readonly scopeId: string;
  readonly sourceId: string;
  readonly pluginKey: string;
  readonly name: string;
  readonly description: string | null;
  readonly mayElicit: boolean | null;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly createdAt: Date;
}

export interface ToolDefinitionRow {
  readonly name: string;
  readonly scopeId: string;
  readonly schema: unknown;
}

// ---------------------------------------------------------------------------
// ToolStore — repository interface for tool persistence
// ---------------------------------------------------------------------------

export interface ToolStore {
  /** Find a single tool by id within a scope. Returns null if not found. */
  readonly findById: (
    id: ToolId,
    scopeId: ScopeId,
  ) => Effect.Effect<ToolRegistration | null>;

  /** Find all tools for a given scope. */
  readonly findByScope: (scopeId: ScopeId) => Effect.Effect<readonly ToolRegistration[]>;

  /** Upsert a batch of tool registrations for a scope. */
  readonly upsert: (
    tools: readonly ToolRegistration[],
    scopeId: ScopeId,
  ) => Effect.Effect<void>;

  /** Delete specific tools by id within a scope. */
  readonly deleteByIds: (
    ids: readonly ToolId[],
    scopeId: ScopeId,
  ) => Effect.Effect<void>;

  /** Delete all tools registered by a given source within a scope. */
  readonly deleteBySource: (sourceId: string, scopeId: ScopeId) => Effect.Effect<void>;

  /** Find all tool definitions for a scope as a plain record. */
  readonly findDefinitions: (scopeId: ScopeId) => Effect.Effect<Record<string, unknown>>;

  /** Upsert a record of tool definitions for a scope. */
  readonly upsertDefinitions: (
    defs: Record<string, unknown>,
    scopeId: ScopeId,
  ) => Effect.Effect<void>;
}
