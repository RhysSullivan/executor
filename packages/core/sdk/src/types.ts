// ---------------------------------------------------------------------------
// Public projections — what consumers see when they call
// `executor.sources.list()` / `executor.tools.list()`. Deliberately leaner
// than the row shapes in core-schema.ts: no plugin_id, no audit columns,
// no raw JSON.
// ---------------------------------------------------------------------------

import type { ToolAnnotations } from "./core-schema";

export interface Source {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly url?: string;
  /** Whether the user can remove this source via
   *  `executor.sources.remove(id)`. `false` for static / built-in
   *  sources declared by plugins at startup. */
  readonly canRemove: boolean;
  /** Whether the plugin supports `executor.sources.refresh(id)`. */
  readonly canRefresh: boolean;
  /** Whether the source has editable config (headers, base url, etc.).
   *  Editing is done via plugin-specific extension methods
   *  (`executor.openapi.updateSource(id, patch)` etc.) — this flag is
   *  just a UI signal. */
  readonly canEdit: boolean;
  /** True if the source was declared statically by a plugin at startup
   *  (in-memory only, no DB row). False if it was added at runtime via
   *  `ctx.core.sources.register(...)`. UI differentiates built-in vs
   *  user-added with this. */
  readonly runtime: boolean;
}

export interface Tool {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: ToolAnnotations;
}

// ---------------------------------------------------------------------------
// Filter passed to `executor.tools.list(...)`. Empty filter = all tools.
// ---------------------------------------------------------------------------

export interface ToolListFilter {
  /** Only tools under this source id. */
  readonly sourceId?: string;
  /** Case-insensitive substring match against `name` OR `description`. */
  readonly query?: string;
}
