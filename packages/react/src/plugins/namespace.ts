/**
 * Normalizes a display name into a valid namespace identifier: lowercase
 * snake_case, only `[a-z0-9_]`, no leading/trailing underscores. Produces
 * strings that are safe to use as TypeScript/tool-name prefixes.
 */
export function slugifyNamespace(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Sanitizes namespace input as the user types without removing intentional
 * underscores that are still in-progress at the field boundaries.
 */
export function normalizeNamespaceInput(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
}
