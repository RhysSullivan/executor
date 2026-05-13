// ---------------------------------------------------------------------------
// Memory adapter conformance run
// ---------------------------------------------------------------------------
//
// Runs the shared DBAdapter conformance suite against the in-memory
// adapter built on top of createAdapter. Catches drift between the
// factory layer and the sqlite/postgres backends.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import type { DBAdapter } from "./adapter";
import { makeMemoryAdapter } from "./testing/memory";
import { conformanceSchema, runAdapterConformance } from "./testing/conformance";

const withAdapter = <A, E>(
  fn: (adapter: DBAdapter) => Effect.Effect<A, E>,
): Effect.Effect<A, E | Error> =>
  Effect.suspend(() => {
    const adapter = makeMemoryAdapter({ schema: conformanceSchema });
    return fn(adapter);
  }) as Effect.Effect<A, E | Error>;

runAdapterConformance("memory (via createAdapter)", withAdapter);
