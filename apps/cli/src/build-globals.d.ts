/**
 * Build-time global injected by `Bun.build({ define: { BUILD_PLATFORM: ... } })`
 * in `apps/cli/src/build.ts`. When absent (e.g. during `bun run dev`), the
 * consuming code must fall back to `process.platform` via a `typeof` check.
 *
 * The value is one of `"darwin"`, `"linux"`, or `"win32"` — matching
 * `target.os` in the compile script.
 */
declare const BUILD_PLATFORM: "darwin" | "linux" | "win32" | undefined;
