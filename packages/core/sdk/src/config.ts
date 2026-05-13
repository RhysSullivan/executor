// ---------------------------------------------------------------------------
// defineExecutorConfig — typed config declaration consumed by both the
// schema-gen CLI and the host runtime. Single source of truth for the
// plugin list. First-party and third-party plugins go through the same
// `bun add @executor-js/plugin-foo` + import-and-call flow.
//
// `plugins` is always a factory `(deps?) => readonly AnyPlugin[]`. Some
// plugins want runtime values from the host (e.g., the openapi plugin's
// `configFile` sink, which is keyed to the active scope cwd and so can't
// be constructed at module-eval time). Deps are optional — the
// schema-gen CLI and Vite plugin call `plugins()` with no args (they
// read `plugin.schema` / `plugin.packageName` only); runtime callers
// pass concrete deps.
//
// Each app declares its own deps shape inline on the factory parameter
// — TS infers `TDeps` from there, so apps don't reach into the SDK's
// types via `declare module`.
// ---------------------------------------------------------------------------

import type { AnyPlugin } from "./plugin";

export type ExecutorDialect = "pg" | "sqlite" | "mysql";

export type ExecutorPluginsFactory<
  TDeps extends object = object,
  TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
> = (deps?: TDeps) => TPlugins;

export interface ExecutorCliConfig<
  TDeps extends object = object,
  TPlugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
> {
  readonly dialect: ExecutorDialect;
  readonly plugins: ExecutorPluginsFactory<TDeps, TPlugins>;
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
 *
 * `TDeps` is inferred from the factory's parameter — apps annotate
 * the destructure (e.g., `({ configFile }: { configFile?: ConfigFileSink })`)
 * directly. No global module augmentation needed.
 */
export const defineExecutorConfig = <
  TDeps extends object,
  const TPlugins extends readonly AnyPlugin[],
>(
  config: ExecutorCliConfig<TDeps, TPlugins>,
): ExecutorCliConfig<TDeps, TPlugins> => config;
