// ---------------------------------------------------------------------------
// Database migration runner using @effect/sql Migrator
// ---------------------------------------------------------------------------

import * as Migrator from "@effect/sql/Migrator";

import { loader } from "./migrations";

/**
 * Run all pending migrations. Safe to call on every startup —
 * already-applied migrations are tracked and skipped.
 */
export const migrate = Migrator.make({})({ loader });
