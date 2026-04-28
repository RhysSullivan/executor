import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { SetSecretInput, type SecretRef } from "@executor/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor/api";

const refToResponse = (ref: SecretRef) => ({
  id: ref.id,
  scopeId: ref.scopeId,
  name: ref.name,
  provider: ref.provider,
  createdAt: ref.createdAt.getTime(),
});

export const SecretsHandlers = HttpApiBuilder.group(ExecutorApi, "secrets", (handlers) =>
  handlers
    .handle("list", () =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const refs = yield* executor.secrets.list();
        return refs.map(refToResponse);
      })),
    )
    .handle("status", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const status = yield* executor.secrets.status(path.secretId);
        return { secretId: path.secretId, status };
      })),
    )
    .handle("set", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const ref = yield* executor.secrets.set(
          new SetSecretInput({
            id: payload.id,
            scope: path.scopeId,
            name: payload.name,
            value: payload.value,
            provider: payload.provider,
          }),
        );
        return refToResponse(ref);
      })),
    )
    .handle("remove", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        yield* executor.secrets.remove(path.secretId);
        return { removed: true };
      })),
    ),
);
