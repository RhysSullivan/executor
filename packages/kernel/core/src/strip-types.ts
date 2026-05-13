import { transform } from "sucrase";

/**
 * Strip TypeScript type syntax (`: T`, `as T`, `<T>`, type aliases,
 * interfaces, etc.) from user-submitted code so it can run in a
 * JavaScript-only sandbox (workerd's WorkerLoader, QuickJS, raw V8).
 * Deno-style runtimes that handle TypeScript natively should skip
 * this step — they get better source-map fidelity by parsing the
 * original input.
 *
 * The execute tool description tells callers to write TypeScript, and
 * `tools.describe.tool` hands them TypeScript shapes — without stripping,
 * a single `: number` annotation throws "Unexpected token ':'" inside
 * the sandbox, which used to surface as a 180s client-side timeout
 * before the engine `raceFirst` fix.
 *
 * Sucrase's TypeScript transform is purely syntactic — no semantic
 * checks, no decorator metadata — which keeps the cost low and matches
 * what `tsc --isolatedModules` / Node's experimental type-stripping do.
 *
 * On parse failure we rethrow the original error so the caller can map
 * it into the runtime's tagged error type. We deliberately do NOT fall
 * back to the raw input — passing TS syntax through to a JS-only
 * sandbox trades a clean error here for an opaque one downstream.
 */
export const stripTypeScript = (code: string): string =>
  transform(code, {
    transforms: ["typescript"],
    // No JSX in user code, no React-specific transforms. `disableESTransforms`
    // keeps sucrase from rewriting `import`/`export` etc — we want only
    // type-syntax removal.
    disableESTransforms: true,
    keepUnusedImports: true,
  }).code;
