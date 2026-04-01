import type { ComponentType } from "react";

/**
 * Contract between the shell and source plugins.
 *
 * The shell owns:
 * - Source list page (renders all sources, common delete action, "add" button)
 * - Source detail chrome (title bar, edit/delete buttons)
 * - Routing between sources
 *
 * The plugin owns:
 * - Everything inside `add` (could be 1 step or a multi-step wizard)
 * - Everything inside `edit` (the config view for that source type)
 * - Optional `summary` for the source list item
 */
export interface SourcePlugin {
  /** Unique key matching the SDK plugin key (e.g. "openapi") */
  readonly key: string;

  /** Display label (e.g. "OpenAPI", "GraphQL") */
  readonly label: string;

  /**
   * The "add source" flow.
   * Plugin controls the entire experience.
   * Call `onComplete` when done, `onCancel` to bail out.
   */
  readonly add: ComponentType<{
    readonly onComplete: () => void;
    readonly onCancel: () => void;
  }>;

  /**
   * The source edit/detail view.
   * Rendered inside the shell's detail chrome.
   */
  readonly edit: ComponentType<{
    readonly sourceId: string;
    readonly onSave: () => void;
  }>;

  /**
   * Optional summary for the source list item.
   * If not provided, the shell renders a default.
   */
  readonly summary?: ComponentType<{
    readonly sourceId: string;
  }>;
}
