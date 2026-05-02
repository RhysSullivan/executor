// ---------------------------------------------------------------------------
// defineExecutorConfig — typed config declaration consumed by both the
// schema-gen CLI and the host runtime. Single source of truth for the
// plugin list. First-party and third-party plugins go through the same
// `bun add @executor-js/plugin-foo` + import-and-call flow.
//
// `plugins` is always a factory `(deps) => readonly AnyPlugin[]`. Some
// plugins want runtime values from the host (e.g., the openapi plugin's
// `configFile` sink, which is keyed to the active scope cwd and so can't
// be constructed at module-eval time). The CLI calls the factory with an
// empty `{}` and reads `plugin.schema` only — never invokes the runtime.
// The host runtime calls the same factory with concrete deps.
// ---------------------------------------------------------------------------

import type { AnyPlugin } from "./plugin";

export type ExecutorDialect = "pg" | "sqlite" | "mysql";

/**
 * Host-supplied dependencies passed to a `plugins` factory at evaluation
 * time. Open by design — host apps cast/extend as needed (e.g., the local
 * app passes `{ configFile: ConfigFileSink }`).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ConfigPluginDeps {}

export type ExecutorPluginsFactory<
  TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
> = (deps: ConfigPluginDeps) => TPlugins;

export interface ExecutorCliConfig<
  TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
> {
  readonly dialect: ExecutorDialect;
  readonly plugins: ExecutorPluginsFactory<TPlugins>;
}

/**
 * Declare an executor config. The CLI imports this file via jiti and
 * reads `plugins` + `dialect` to generate the drizzle schema; the host
 * runtime imports the same file to instantiate plugins. Plugin runtime
 * credentials passed to the factory may be stubs from the CLI — only
 * `plugin.schema` is read there.
 *
 * The `const TPlugins` modifier preserves the tuple-literal inference
 * from the factory's return so per-plugin extension typing flows through
 * (`ReturnType<typeof config.plugins>` keeps `[OpenApi, Mcp, ...]`).
 */
export const defineExecutorConfig = <
  const TPlugins extends readonly AnyPlugin[],
>(
  config: ExecutorCliConfig<TPlugins>,
): ExecutorCliConfig<TPlugins> => config;
