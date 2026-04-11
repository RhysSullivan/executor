// ---------------------------------------------------------------------------
// Migration loader — static imports, no dynamic import / filesystem needed
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import type { ResolvedMigration } from "@effect/sql/Migrator";

import migration_0001 from "./0001_initial";
import migration_0002 from "./0002_executions";

export const loader: Effect.Effect<ReadonlyArray<ResolvedMigration>> = Effect.succeed([
  [1, "initial", Effect.succeed(migration_0001)],
  [2, "executions", Effect.succeed(migration_0002)],
]);
