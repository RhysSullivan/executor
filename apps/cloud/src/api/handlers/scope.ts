import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { capture } from "@executor/api";
import { ExecutorService } from "@executor/api/server";

import { ProtectedCloudApi } from "../api";

// `/scope` — no scopeId path param, so no `assertScopeAccess` call.
// Returns the caller's authenticated scope (the one the request-scoped
// executor was built for), which is already pinned to the session.
export const ScopeHandlers = HttpApiBuilder.group(ProtectedCloudApi, "scope", (handlers) =>
  handlers.handle("info", () =>
    capture(
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const scope = executor.scopes.at(-1)!;
        return {
          id: scope.id,
          name: scope.name,
          dir: scope.name,
        };
      }),
    ),
  ),
);
