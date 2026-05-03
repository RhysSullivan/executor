// ---------------------------------------------------------------------------
// loadPluginsFromJsonc — runtime plugin loader.
//
// Reads `executor.jsonc#plugins`, dynamically imports each package's
// `./server` entry via jiti (so workspace TS sources work in dev and
// published `dist/*.js` works after install), and calls the exported
// `definePlugin(...)` factory with merged `options` plus host-injected
// deps. Returns the resulting `Plugin[]` ready to hand to
// `composePluginApi` / `createExecutor`.
//
// jiti is used instead of bare `import()` because:
//   - workspace plugins under monorepo dev expose `.ts` source via the
//     `bun` export condition; Node's loader can't read those directly,
//     jiti transpiles on the fly.
//   - in a published environment the package's `default` condition
//     points at `dist/*.js`, which jiti loads as a normal ESM module.
//
// The convention is: every plugin package exports a `./server` subpath
// whose default export is a `ConfiguredPlugin` (the result of
// `definePlugin(...)`). Calling that with `{ ...options, ...deps }`
// returns a concrete `Plugin`.
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as jsonc from "jsonc-parser";

import type { AnyPlugin } from "@executor-js/sdk";

// Plugins are invoked dynamically by name — exact author types are
// unknown at the call site, so the loader treats every factory as
// `(options?: unknown) => AnyPlugin`. The plugin author's types still
// hold inside the plugin's own module; we just don't propagate them
// across the runtime boundary.
type LooseConfiguredPlugin = (options?: Record<string, unknown>) => AnyPlugin;

import type { PluginConfig } from "./schema";

export interface LoadPluginsFromJsoncOptions {
  /** Absolute path to `executor.jsonc` (or compatible). */
  readonly path: string;
  /**
   * Host-injected deps merged into each plugin's options. Common keys:
   * `configFile` (the `ConfigFileSink`), env-derived credentials, etc.
   * Plugins ignore deps they don't accept — `definePlugin` strips
   * unknown keys before forwarding to the author factory.
   */
  readonly deps?: Readonly<Record<string, unknown>>;
}

/**
 * Returns the plugins listed in jsonc, or `null` if the file is missing
 * or has no `plugins` array. The host treats `null` as "fall back to
 * the static `executor.config.ts` factory."
 */
export const loadPluginsFromJsonc = async (
  options: LoadPluginsFromJsoncOptions,
): Promise<readonly AnyPlugin[] | null> => {
  const { path, deps } = options;
  if (!fs.existsSync(path)) return null;

  const raw = fs.readFileSync(path, "utf8");
  const errors: jsonc.ParseError[] = [];
  const parsed = jsonc.parse(raw, errors) as
    | { plugins?: readonly PluginConfig[] }
    | undefined;
  if (errors.length > 0) {
    const msg = errors
      .map((e) => `offset ${e.offset}: ${jsonc.printParseErrorCode(e.error)}`)
      .join("; ");
    throw new Error(`[load-plugins] failed to parse ${path}: ${msg}`);
  }

  const entries = parsed?.plugins ?? null;
  if (!entries || entries.length === 0) return null;

  // jiti is created once per call; `moduleCache: false` ensures a
  // restart picks up freshly-installed packages without process restart
  // (relevant when the dev server kicks a reload after `executor plugin
  // install`).
  const { createJiti } = await import("jiti");
  const jiti = createJiti(pathToFileURL(path).href, {
    interopDefault: true,
    moduleCache: false,
  });

  const fromDir = dirname(path);
  // require.resolve is anchored to the jsonc's directory so plugin
  // packages resolve from the host app's `node_modules` regardless of
  // CWD.
  const require = createRequire(
    isAbsolute(path) ? path : resolvePath(fromDir, "_anchor.js"),
  );

  const loaded: AnyPlugin[] = [];
  for (const entry of entries) {
    const serverEntry = `${entry.package}/server`;
    let resolved: string;
    try {
      resolved = require.resolve(serverEntry);
    } catch {
      throw new Error(
        `[load-plugins] cannot resolve "${serverEntry}" from ${fromDir}. ` +
          `Is "${entry.package}" installed and does it export "./server"?`,
      );
    }
    const mod = (await jiti.import(resolved)) as
      | { default?: LooseConfiguredPlugin }
      | LooseConfiguredPlugin;
    const factory = (
      typeof mod === "function" ? mod : (mod.default ?? null)
    ) as LooseConfiguredPlugin | null;
    if (!factory || typeof factory !== "function") {
      throw new Error(
        `[load-plugins] "${serverEntry}" did not export a default ` +
          `definePlugin(...) factory.`,
      );
    }
    const merged = { ...(deps ?? {}), ...(entry.options ?? {}) };
    loaded.push(factory(merged));
  }

  return loaded;
};
