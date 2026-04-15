import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { SecretNotFoundError, type SecretRef } from "@executor/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";

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
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const refs = yield* executor.secrets.list().pipe(Effect.orDie);
        return refs.map(refToResponse);
      }),
    )
    .handle("status", ({ path }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const status = yield* executor.secrets.status(path.secretId).pipe(Effect.orDie);
        return { secretId: path.secretId, status };
      }),
    )
    .handle("set", ({ payload }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const ref = yield* executor.secrets
          .set({
            id: payload.id,
            name: payload.name,
            value: payload.value,
            provider: payload.provider,
          })
          .pipe(Effect.orDie);
        return refToResponse(ref);
      }),
    )
    .handle("resolve", ({ path }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const value = yield* executor.secrets.get(path.secretId).pipe(Effect.orDie);
        if (value === null) {
          return yield* Effect.fail(new SecretNotFoundError({ secretId: path.secretId }));
        }
        return { secretId: path.secretId, value };
      }),
    )
    .handle("remove", ({ path }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        yield* executor.secrets.remove(path.secretId).pipe(Effect.orDie);
        return { removed: true };
      }),
    ),
);
