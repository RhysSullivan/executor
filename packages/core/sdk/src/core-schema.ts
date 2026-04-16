// ---------------------------------------------------------------------------
// Core data model — the SDK owns these tables. Plugins write into them via
// `ctx.core.sources.register(...)` and `ctx.core.definitions.register(...)`;
// the executor reads from them directly on every list / invoke / schema
// call. There is no in-memory registry layered on top.
//
// Static (code-declared) sources and tools are NOT in these tables — they
// live in an in-memory map built at executor startup from each plugin's
// `staticSources` declaration. See executor.ts. The DB only holds
// dynamic (runtime-registered) rows.
// ---------------------------------------------------------------------------

import type {
  DBSchema,
  InferDBFieldsOutput,
} from "@executor/storage-core";

export const coreSchema = {
  source: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      plugin_id: { type: "string", required: true, index: true },
      kind: { type: "string", required: true },
      name: { type: "string", required: true },
      url: { type: "string", required: false },
      can_remove: {
        type: "boolean",
        required: true,
        defaultValue: true,
      },
      can_refresh: {
        type: "boolean",
        required: true,
        defaultValue: false,
      },
      can_edit: {
        type: "boolean",
        required: true,
        defaultValue: false,
      },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  tool: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      plugin_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      description: { type: "string", required: true },
      input_schema: { type: "json", required: false },
      output_schema: { type: "json", required: false },
      // NOTE: tool annotations (requiresApproval, approvalDescription,
      // mayElicit) are NOT stored on this row. They're derived at read
      // time from plugin-owned data via `plugin.resolveAnnotations`,
      // because the source of truth already lives in each plugin's own
      // storage (openapi's OperationBinding, etc.) and duplicating it
      // here would just mean bulk-rewriting rows every time the
      // derivation logic changes.
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  // Shared JSON-schema `$defs` stored once per source. Tool input/output
  // schemas carry `$ref: "#/$defs/X"` pointers; the read path attaches
  // matching defs under `$defs` before returning. Keyed by synthetic id
  // `${source_id}.${name}` so cleanup on source removal is a single
  // deleteMany by source_id.
  definition: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      plugin_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      schema: { type: "json", required: true },
      created_at: { type: "date", required: true },
    },
  },
  // Secrets live in the core surface as metadata (id, display name,
  // provider key). Actual values never touch this table — they live in
  // the secret provider (keychain, 1password, file, etc.) and are
  // resolved on demand via `ctx.secrets.get(id)`.
  secret: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      provider: { type: "string", required: true, index: true },
      created_at: { type: "date", required: true },
    },
  },
} as const satisfies DBSchema;

export type CoreSchema = typeof coreSchema;

// ---------------------------------------------------------------------------
// Row types — derived from the schema. Adding a field to coreSchema.fields
// adds it to the row type automatically.
// ---------------------------------------------------------------------------

export type SourceRow = InferDBFieldsOutput<CoreSchema["source"]["fields"]> &
  Record<string, unknown>;

export type ToolRow = InferDBFieldsOutput<CoreSchema["tool"]["fields"]> &
  Record<string, unknown>;

export type DefinitionRow = InferDBFieldsOutput<
  CoreSchema["definition"]["fields"]
> &
  Record<string, unknown>;

export type SecretRow = InferDBFieldsOutput<CoreSchema["secret"]["fields"]> &
  Record<string, unknown>;

// ---------------------------------------------------------------------------
// Tool annotations — default-policy metadata the executor consults
// before invocation. Returned by `plugin.resolveAnnotations` (dynamic
// tools) or declared inline on `StaticToolDecl` (static tools). Never
// stored on `tool` rows — every field here is derived at read time
// from plugin-owned data.
//
// OpenAPI derives from HTTP method:
//   - GET / HEAD / OPTIONS → {} (auto-approved)
//   - POST / PUT / PATCH / DELETE → { requiresApproval: true,
//                                     approvalDescription: "DELETE /users/:id" }
//
// MCP derives from the server's tool declaration (mcp has its own
// may-elicit and approval signals).
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  /** If true, the executor will call the invoke-time elicitation handler
   *  before running the tool and abort if the user declines. */
  readonly requiresApproval?: boolean;
  /** Free-text message shown in the approval prompt. Falls back to the
   *  tool's id / description if unset. */
  readonly approvalDescription?: string;
  /** Hint for UI — tool may suspend to ask the user for input mid-invocation.
   *  Not enforced by the executor; purely a UI signal. */
  readonly mayElicit?: boolean;
}

// ---------------------------------------------------------------------------
// SourceInput — what a plugin passes to `ctx.core.sources.register(...)`.
// Writes both the source row and all its tool rows in one transaction.
// Annotations are NOT part of this input — they're computed from
// plugin-owned data via `plugin.resolveAnnotations` when the executor
// needs them.
// ---------------------------------------------------------------------------

export interface SourceInputTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export interface SourceInput {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly url?: string;
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
  readonly canEdit?: boolean;
  readonly tools: readonly SourceInputTool[];
}

// ---------------------------------------------------------------------------
// DefinitionsInput — paired with SourceInput when a plugin registers
// shared JSON-schema `$defs` alongside a source. Usually called inside
// the same `ctx.transaction` as `sources.register` so a failure rolls
// back both the source rows and the def rows.
// ---------------------------------------------------------------------------

export interface DefinitionsInput {
  readonly sourceId: string;
  readonly definitions: Record<string, unknown>;
}
