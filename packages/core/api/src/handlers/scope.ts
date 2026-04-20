import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor/api";

export const ScopeHandlers = HttpApiBuilder.group(ExecutorApi, "scope", (handlers) =>
  handlers.handle("info", () =>
    capture(Effect.gen(function* () {
      const executor = yield* ExecutorService;
      // Outermost scope (organization / workspace). A follow-up that
      // exposes per-user stacks end-to-end can extend this response
      // with the full list; for now, single-scope deployments and the
      // current `[org]` cloud setup see identical output.
      const scope = executor.scopes.at(-1)!;
      return {
        id: scope.id,
        name: scope.name,
        dir: scope.name,
      };
    })),
  ),
);
