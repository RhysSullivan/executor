// ---------------------------------------------------------------------------
// defineExecutorConfig — typed config declaration for the CLI.
//
// Analogous to better-auth's `auth.ts` config file. The CLI loads this
// to read the plugin list and dialect without constructing a real executor
// (which needs a live database connection). Plugin factories may receive
// stub credentials here — the CLI only reads `plugin.schema`, never calls
// the plugin at runtime.
// ---------------------------------------------------------------------------

import type { AnyPlugin } from "./plugin";

export type ExecutorDialect = "pg" | "sqlite" | "mysql";

export interface ExecutorCliConfig {
  readonly dialect: ExecutorDialect;
  readonly plugins: readonly AnyPlugin[];
}

/**
 * Declare an executor config for the CLI to consume. The CLI imports
 * this file via jiti and reads `plugins` + `dialect` to generate the
 * drizzle schema. Plugin runtime credentials can be stubs — only
 * `plugin.schema` is read.
 */
export const defineExecutorConfig = <const T extends ExecutorCliConfig>(
  config: T,
): T => config;
