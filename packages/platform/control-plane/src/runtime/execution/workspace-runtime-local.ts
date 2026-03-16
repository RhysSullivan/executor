import * as Effect from "effect/Effect";

import {
  provideOptionalRuntimeLocalWorkspace,
  type RuntimeLocalWorkspaceState,
} from "../local/local-runtime-context";

export const provideRuntimeLocalWorkspace = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  runtimeLocalWorkspace: RuntimeLocalWorkspaceState | null,
): Effect.Effect<A, E, R> =>
  provideOptionalRuntimeLocalWorkspace(effect, runtimeLocalWorkspace);
