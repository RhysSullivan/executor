import { Context, Effect, Schema } from "effect";

// ---------------------------------------------------------------------------
// Source — a tool provider instance (e.g. "GitHub REST API")
// ---------------------------------------------------------------------------

export class Source extends Schema.Class<Source>("Source")({
  /** Unique namespace identifier (e.g. "github_rest") */
  id: Schema.String,
  /** Human-readable name */
  name: Schema.String,
  /** Plugin kind that manages this source (e.g. "openapi", "mcp") */
  kind: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// SourceManager — plugin-provided source lifecycle handler
//
// Each plugin registers one of these during init. The SourceRegistry
// delegates to it for all operations on sources of that kind.
// ---------------------------------------------------------------------------

export interface SourceManager {
  /** Plugin kind this manager handles (e.g. "openapi", "mcp") */
  readonly kind: string;

  /** List all sources managed by this plugin */
  readonly list: () => Effect.Effect<readonly Source[]>;

  /** Remove a source and clean up its tools + internal state */
  readonly remove: (sourceId: string) => Effect.Effect<void>;

  /** Re-fetch / re-register tools for a source */
  readonly refresh?: (sourceId: string) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// SourceRegistry — core service, coordinates across all plugins
// ---------------------------------------------------------------------------

export class SourceRegistry extends Context.Tag(
  "@executor/sdk/SourceRegistry",
)<
  SourceRegistry,
  {
    /** Register a source manager (called by plugins during init) */
    readonly addManager: (manager: SourceManager) => Effect.Effect<void>;

    /** List all sources across all plugins */
    readonly list: () => Effect.Effect<readonly Source[]>;

    /** Remove a source by id. Finds the owning manager and delegates. */
    readonly remove: (sourceId: string) => Effect.Effect<void>;

    /** Refresh a source by id. Finds the owning manager and delegates. */
    readonly refresh: (sourceId: string) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export const makeInMemorySourceRegistry = () => {
  const managers = new Map<string, SourceManager>();

  return {
    addManager: (manager: SourceManager) =>
      Effect.sync(() => {
        managers.set(manager.kind, manager);
      }),

    list: () =>
      Effect.gen(function* () {
        const all: Source[] = [];
        for (const manager of managers.values()) {
          const sources = yield* manager.list();
          all.push(...sources);
        }
        return all;
      }),

    remove: (sourceId: string) =>
      Effect.gen(function* () {
        for (const manager of managers.values()) {
          const sources = yield* manager.list();
          if (sources.some((s) => s.id === sourceId)) {
            yield* manager.remove(sourceId);
            return;
          }
        }
      }),

    refresh: (sourceId: string) =>
      Effect.gen(function* () {
        for (const manager of managers.values()) {
          const sources = yield* manager.list();
          if (sources.some((s) => s.id === sourceId)) {
            if (manager.refresh) {
              yield* manager.refresh(sourceId);
            }
            return;
          }
        }
      }),
  };
};
