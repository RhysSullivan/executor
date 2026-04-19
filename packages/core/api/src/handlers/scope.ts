import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor/api";

export const ScopeHandlers = HttpApiBuilder.group(ExecutorApi, "scope", (handlers) =>
  handlers.handle("info", () =>
    capture(Effect.gen(function* () {
      const executor = yield* ExecutorService;
      return {
        id: executor.scope.id,
        name: executor.scope.name,
        dir: executor.scope.name,
        chain: executor.scopeStack.read.map((s) => ({ id: s.id, name: s.name })),
      };
    })),
  ),
);
