import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor-js/api";

export const CredentialBindingsHandlers = HttpApiBuilder.group(
  ExecutorApi,
  "credentialBindings",
  (handlers) =>
    handlers
      .handle("listForSource", ({ params }) =>
        capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            return yield* executor.credentialBindings.listForSource({
              pluginId: params.pluginId,
              sourceId: params.sourceId,
              sourceScope: params.sourceScope,
            });
          }),
        ),
      )
      .handle("set", ({ payload }) =>
        capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            return yield* executor.credentialBindings.set(payload);
          }),
        ),
      )
      .handle("remove", ({ payload }) =>
        capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            yield* executor.credentialBindings.remove(payload);
            return { removed: true };
          }),
        ),
      ),
);
