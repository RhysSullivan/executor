// ---------------------------------------------------------------------------
// Fire-and-forget execution usage tracker against Autumn.
// ---------------------------------------------------------------------------
//
// Lives in `services/` rather than `api/` because callers on the Durable
// Object path (`mcp-session.ts` → `execution-stack.ts`) transitively pull
// it in, and anything under `api/` eventually re-exports from
// `api/layers.ts`, which imports `auth/handlers.ts` → `@tanstack/react-start`
// — that pulls the `#tanstack-start-plugin-adapters` subpath specifier
// into Vite's resolver and breaks vitest-pool-workers module load.
//
// This file has exactly one responsibility, no HTTP concerns, and imports
// nothing from `api/`.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import type { AutumnService } from "./autumn";

export const makeTrackExecutionUsage = (autumn: AutumnService["Type"]) => {
  return (organizationId: string): void => {
    autumn
      .use((client) =>
        client.track({
          customerId: organizationId,
          featureId: "executions",
          value: 1,
        }),
      )
      .pipe(
        Effect.catchAll((err) => {
          console.error("[billing] track failed:", err);
          return Effect.void;
        }),
        Effect.runFork,
      );
  };
};
