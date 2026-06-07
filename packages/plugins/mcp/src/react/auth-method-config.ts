// ---------------------------------------------------------------------------
// MCP ↔ generic auth-template converter.
//
// The shared add-time `AuthTemplateEditor` speaks the plugin-agnostic
// `AuthTemplateEditorValue`. MCP's stored auth is a single `McpAuthTemplate`
// (`none` / `header` / `oauth2`) — one method, not an array. This converts the
// editor value to that shape and lives with the MCP plugin because it touches
// the transport-specific `McpAuthTemplate` type.
// ---------------------------------------------------------------------------

import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";

import type { McpAuthTemplate } from "../sdk/types";

/** Convert a generic editor value into MCP's single `McpAuthTemplate`. An
 *  apiKey method maps to a `header` template using its FIRST header placement
 *  (MCP carries a single header, not an array); a header placement's prefix is
 *  preserved. OAuth maps to `oauth2`; `none` to `none`. An apiKey value with no
 *  usable header placement falls back to `none`. */
export function mcpAuthTemplateFromEditorValue(value: AuthTemplateEditorValue): McpAuthTemplate {
  if (value.kind === "oauth") return { kind: "oauth2" };
  if (value.kind === "apikey") {
    const header = value.placements.find(
      (placement) => placement.carrier === "header" && placement.name.trim().length > 0,
    );
    if (!header) return { kind: "none" };
    return {
      kind: "header",
      headerName: header.name.trim(),
      ...(header.prefix ? { prefix: header.prefix } : {}),
    };
  }
  return { kind: "none" };
}
