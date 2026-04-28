import type { ComponentType } from "react";

/**
 * A curated preset — a well-known API/service that can be added with one click.
 * Each plugin provides its own presets.
 */
export interface SourcePreset {
  /** Unique id (e.g. "stripe", "github-graphql") */
  readonly id: string;
  /** Display name */
  readonly name: string;
  /** One-line description */
  readonly summary: string;
  /**
   * URL passed as `initialUrl` to the add form.
   * Omit for presets that don't use a URL (e.g. stdio MCP presets).
   */
  readonly url?: string;
  /** Optional icon URL (favicon, logo) */
  readonly icon?: string;
  /** When true, this preset is shown in the top-level grid on the sources page. */
  readonly featured?: boolean;
}

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
   * `initialUrl` is provided when the user arrived via URL auto-detection.
   * `initialPreset` is provided when the user clicked a preset card.
   */
  readonly add: ComponentType<{
    readonly onComplete: () => void;
    readonly onCancel: () => void;
    readonly initialUrl?: string;
    readonly initialPreset?: string;
    readonly initialNamespace?: string;
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
    readonly variant?: "badge" | "panel";
    readonly onAction?: () => void;
  }>;

  /**
   * Optional top-bar action for signing in / reconnecting to the source.
   * Rendered by the shell next to Edit when present. Plugins that don't
   * support interactive sign-in (no OAuth etc.) simply omit this.
   *
   * Deliberately separate from `edit` — edit is source config, sign-in is
   * the user-level connection lifecycle. A source can be valid-to-edit
   * while its sign-in is expired / missing, and vice versa.
   */
  readonly signIn?: ComponentType<{
    readonly sourceId: string;
  }>;

  /** Curated presets shown on the sources page for quick-add */
  readonly presets?: readonly SourcePreset[];
}
