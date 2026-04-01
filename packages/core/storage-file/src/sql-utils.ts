// ---------------------------------------------------------------------------
// SQL helper — absorb SqlError into defects (die)
// ---------------------------------------------------------------------------

import { Effect } from "effect";
import { SqlError } from "@effect/sql/SqlError";

/**
 * Run an effect that may fail with SqlError, converting to a defect.
 */
export const absorbSql = <A, E>(
  effect: Effect.Effect<A, E | SqlError>,
): Effect.Effect<A, Exclude<E, SqlError>> =>
  effect.pipe(
    Effect.catchAll((e) =>
      e instanceof SqlError ? Effect.die(e) : Effect.fail(e as Exclude<E, SqlError>),
    ),
  );
