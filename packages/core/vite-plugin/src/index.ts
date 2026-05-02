// ---------------------------------------------------------------------------
// @executor-js/vite-plugin — wires `executor.config.ts` into the host's
// Vite build so plugin-contributed pages, widgets, and slot components
// are bundled automatically. The host imports
// `virtual:executor/plugins-client` and gets a typed list of every
// loaded plugin's `defineClientPlugin(...)` value.
//
// Resolution model (one config, two consumers):
//   - The server already imports plugin factories from
//     `executor.config.ts` and runs them via `plugins({ configFile })`.
//   - This Vite plugin loads the same `executor.config.ts` at build/dev
//     start, calls `plugins({})` to enumerate them (factories must be
//     side-effect free for inspection — same contract the schema-gen
//     CLI relies on), reads each spec's `packageName`, and emits an
//     import for `${packageName}/client`.
//   - Plugins without a `packageName` are SDK-only and contribute
//     nothing to the frontend bundle — they're skipped.
//   - No conventions, no scope assumptions, no name transforms. The
//     plugin author writes the same package name they publish to npm.
//
// HMR: the virtual module is part of Vite's graph. Changing
// `executor.config.ts` invalidates it and triggers a hot update for
// plugin-list consumers; adding/removing a plugin requires a Vite
// restart (because npm dep graph changed).
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import type { ExecutorCliConfig } from "@executor-js/sdk";

const VIRTUAL_ID = "virtual:executor/plugins-client";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const DEFAULT_CONFIG_CANDIDATES = [
  "executor.config.ts",
  "executor.config.js",
  "executor.config.mjs",
  "src/executor.config.ts",
  "src/executor.config.js",
];

const tryResolveClient = (
  packageName: string,
  fromDir: string,
): string | null => {
  const require = createRequire(resolvePath(fromDir, "_anchor.js"));
  try {
    return require.resolve(`${packageName}/client`);
  } catch {
    return null;
  }
};

interface ExecutorVitePluginOptions {
  /**
   * Path to the executor config file. Resolved relative to the Vite
   * project root if not absolute. Defaults to the first match of
   * `executor.config.ts` / `.js` / `.mjs` (with a fallback under
   * `src/`).
   */
  readonly configPath?: string;
}

export default function executorVitePlugin(
  options: ExecutorVitePluginOptions = {},
): Plugin {
  let projectRoot: string = process.cwd();
  let resolvedConfigPath: string | null = null;
  let cachedSource: string | null = null;

  const resolveConfigPath = (): string | null => {
    if (resolvedConfigPath) return resolvedConfigPath;
    const candidates = options.configPath
      ? [options.configPath]
      : DEFAULT_CONFIG_CANDIDATES;
    for (const candidate of candidates) {
      const abs = isAbsolute(candidate)
        ? candidate
        : resolvePath(projectRoot, candidate);
      if (existsSync(abs)) {
        resolvedConfigPath = abs;
        return abs;
      }
    }
    return null;
  };

  const loadVirtualSource = async (): Promise<string> => {
    if (cachedSource !== null) return cachedSource;

    const configPath = resolveConfigPath();
    if (!configPath) {
      cachedSource =
        "// no executor.config.ts found — empty plugin list\n" +
        "export const plugins = [];\n";
      return cachedSource;
    }

    // jiti is a dev dep of consumers; importing dynamically lets the
    // plugin be lazy-loaded and avoids a hard requirement when the
    // host doesn't actually use plugins yet.
    const { createJiti } = await import("jiti");
    const jiti = createJiti(pathToFileURL(configPath).href, {
      interopDefault: true,
      moduleCache: false,
    });
    const mod = (await jiti.import(configPath)) as
      | { default?: ExecutorCliConfig }
      | ExecutorCliConfig;
    const config = ("default" in mod && mod.default ? mod.default : mod) as ExecutorCliConfig;

    const specs = config.plugins({});
    const fromDir = dirname(configPath);
    const lines: string[] = [];
    const exportNames: string[] = [];

    for (const spec of specs) {
      // SDK-only plugins (no `packageName`) contribute nothing to the
      // frontend bundle — skip silently.
      if (!spec.packageName) continue;
      const resolved = tryResolveClient(spec.packageName, fromDir);
      if (!resolved) {
        // packageName was set but didn't resolve. Likely culprits:
        // a typo, a package that hasn't published `./client` in its
        // exports map yet, or the package isn't installed. Warn
        // loudly so the dev sees their plugin's UI is missing instead
        // of silently shipping a host without it.
        console.warn(
          `[@executor-js/vite-plugin] plugin "${spec.id}" set packageName ` +
            `"${spec.packageName}" but ${spec.packageName}/client could ` +
            `not be resolved from ${fromDir}. The plugin's UI will not be ` +
            `bundled. Check that the package is installed and exports a ` +
            `\`./client\` subpath in its package.json.`,
        );
        continue;
      }
      const ident = `__executor_plugin_${exportNames.length}`;
      lines.push(`import ${ident} from ${JSON.stringify(`${spec.packageName}/client`)};`);
      exportNames.push(ident);
    }

    cachedSource =
      `${lines.join("\n")}\n` +
      `export const plugins = [${exportNames.join(", ")}];\n`;
    return cachedSource;
  };

  return {
    name: "@executor-js/vite-plugin",
    enforce: "pre",
    configResolved(config) {
      projectRoot = config.root;
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return loadVirtualSource();
    },
    handleHotUpdate(ctx) {
      const configPath = resolveConfigPath();
      if (!configPath || ctx.file !== configPath) return undefined;
      cachedSource = null;
      const mod = ctx.server.moduleGraph.getModuleById(RESOLVED_ID);
      return mod ? [mod] : undefined;
    },
  };
}

// Consumers wanting strong typing for `virtual:executor/plugins-client`
// should add the following to a `vite-env.d.ts` (or any ambient `.d.ts`):
//
//   declare module "virtual:executor/plugins-client" {
//     import type { ClientPluginSpec } from "@executor-js/sdk/client";
//     export const plugins: readonly ClientPluginSpec[];
//   }
//
// We don't ship the augmentation from this package because TS module
// augmentation can only target modules TS already resolves, and Vite
// virtual ids aren't resolvable by the type checker on their own.
