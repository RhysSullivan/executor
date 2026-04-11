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
  /** Optional upstream URL for this source — used to derive a favicon in the UI */
  url: Schema.optional(Schema.String),
  /** True when the source is provided by the running executor */
  runtime: Schema.optional(Schema.Boolean),
  /** Whether the source supports removal */
  canRemove: Schema.optional(Schema.Boolean),
  /** Whether the source supports refresh */
  canRefresh: Schema.optional(Schema.Boolean),
  /** Whether the source supports editing (config changes) */
  canEdit: Schema.optional(Schema.Boolean),
}) {}

// ---------------------------------------------------------------------------
// SourceDetectionResult — returned by detect() on a SourceManager
// ---------------------------------------------------------------------------

export class SourceDetectionResult extends Schema.Class<SourceDetectionResult>(
  "SourceDetectionResult",
)({
  /** Plugin kind that detected this source */
  kind: Schema.String,
  /** How confident the plugin is that the URL matches */
  confidence: Schema.Literal("high", "medium", "low"),
  /** The URL that was probed */
  endpoint: Schema.String,
  /** Suggested human-readable name */
  name: Schema.String,
  /** Suggested namespace */
  namespace: Schema.String,
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

  /** Detect whether a URL matches this plugin's source type */
  readonly detect?: (url: string) => Effect.Effect<SourceDetectionResult | null>;
}

// ---------------------------------------------------------------------------
// SourceRegistry — core service, coordinates across all plugins
// ---------------------------------------------------------------------------

export class SourceRegistry extends Context.Tag("@executor/sdk/SourceRegistry")<
  SourceRegistry,
  {
    /** Register a source manager (called by plugins during init) */
    readonly addManager: (manager: SourceManager) => Effect.Effect<void>;

    /** Register a runtime-only source entry. */
    readonly registerRuntime: (source: Source) => Effect.Effect<void>;

    /** Unregister a runtime-only source entry by id. */
    readonly unregisterRuntime: (sourceId: string) => Effect.Effect<void>;

    /** List all sources across all plugins */
    readonly list: () => Effect.Effect<readonly Source[]>;

    /** Remove a source by id. Finds the owning manager and delegates. */
    readonly remove: (sourceId: string) => Effect.Effect<void>;

    /** Refresh a source by id. Finds the owning manager and delegates. */
    readonly refresh: (sourceId: string) => Effect.Effect<void>;

    /** Detect source type from a URL by probing all registered plugins */
    readonly detect: (url: string) => Effect.Effect<readonly SourceDetectionResult[]>;
  }
>() {}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export const makeInMemorySourceRegistry = () => {
  const managers = new Map<string, SourceManager>();
  const runtimeSources = new Map<string, Source>();

  return {
    addManager: (manager: SourceManager) =>
      Effect.sync(() => {
        managers.set(manager.kind, manager);
      }),

    registerRuntime: (source: Source) =>
      Effect.sync(() => {
        runtimeSources.set(source.id, source);
      }),

    unregisterRuntime: (sourceId: string) =>
      Effect.sync(() => {
        runtimeSources.delete(sourceId);
      }),

    list: () =>
      Effect.gen(function* () {
        const all: Source[] = [...runtimeSources.values()];
        for (const manager of managers.values()) {
          const sources = yield* manager.list();
          all.push(...sources);
        }
        return all;
      }),

    remove: (sourceId: string) =>
      Effect.gen(function* () {
        const runtimeSource = runtimeSources.get(sourceId);
        if (runtimeSource) {
          if (runtimeSource.canRemove) {
            runtimeSources.delete(sourceId);
          }
          return;
        }

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
        const runtimeSource = runtimeSources.get(sourceId);
        if (runtimeSource) {
          return;
        }

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

    detect: (url: string) =>
      Effect.gen(function* () {
        const detectors = [...managers.values()]
          .filter((m) => m.detect)
          .map((m) =>
            m.detect!(url).pipe(
              Effect.timeout("5 seconds"),
              Effect.catchAll(() => Effect.succeed(null)),
            ),
          );

        const results = yield* Effect.all(detectors, { concurrency: "unbounded" });
        return results
          .filter((r): r is SourceDetectionResult => r !== null)
          .sort((a, b) => {
            const order = { high: 0, medium: 1, low: 2 };
            return order[a.confidence] - order[b.confidence];
          });
      }),
  };
};
