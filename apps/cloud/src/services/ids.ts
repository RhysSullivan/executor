// ---------------------------------------------------------------------------
// Cloud id helpers
// ---------------------------------------------------------------------------
//
// `slugifyHandle / withHandleSuffix` generate org URL handles from
// human-entered names. Caller is responsible for collision handling — see
// `pickFreeOrgHandle` in `./user-store`.

const HANDLE_MAX = 48;

/**
 * Reduce a free-form name to a handle/slug. Lowercase, ASCII-ish, hyphenated.
 * Caller is responsible for collision handling — see `withHandleSuffix`.
 */
export const slugifyHandle = (name: string): string => {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, HANDLE_MAX);
  return cleaned.length > 0 ? cleaned : "org";
};

/**
 * Append a numeric suffix to a handle, keeping the result within HANDLE_MAX.
 * `withHandleSuffix("acme", 2)` → `"acme-2"`.
 */
export const withHandleSuffix = (handle: string, n: number): string => {
  const suffix = `-${n}`;
  const room = HANDLE_MAX - suffix.length;
  const base = handle.slice(0, Math.max(1, room));
  return `${base}${suffix}`;
};
