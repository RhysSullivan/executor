import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { SecretNotFoundError, SetSecretInput, type SecretRef } from "@executor/sdk";

import { capture } from "@executor/api";
import { ExecutorService } from "@executor/api/server";

import { assertScopeAccess } from "../../auth/scope-access";
import { ProtectedCloudApi } from "../api";

const refToResponse = (ref: SecretRef) => ({
  id: ref.id,
  scopeId: ref.scopeId,
  name: ref.name,
  provider: ref.provider,
  createdAt: ref.createdAt.getTime(),
});

export const SecretsHandlers = HttpApiBuilder.group(ProtectedCloudApi, "secrets", (handlers) =>
  handlers
    .handle("list", ({ path }) =>
      Effect.gen(function* () {
        yield* assertScopeAccess(path.scopeId);
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const refs = yield* executor.secrets.list();
            return refs.map(refToResponse);
          }),
        );
      }),
    )
    .handle("status", ({ path }) =>
      Effect.gen(function* () {
        yield* assertScopeAccess(path.scopeId);
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const status = yield* executor.secrets.status(path.secretId);
            return { secretId: path.secretId, status };
          }),
        );
      }),
    )
    .handle("set", ({ path, payload }) =>
      Effect.gen(function* () {
        yield* assertScopeAccess(path.scopeId);
        return yield* capture(
          Effect.gen(function* () {
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
          }),
        );
      }),
    )
    .handle("resolve", ({ path }) =>
      Effect.gen(function* () {
        yield* assertScopeAccess(path.scopeId);
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const value = yield* executor.secrets.get(path.secretId);
            if (value === null) {
              return yield* Effect.fail(new SecretNotFoundError({ secretId: path.secretId }));
            }
            return { secretId: path.secretId, value };
          }),
        );
      }),
    )
    .handle("remove", ({ path }) =>
      Effect.gen(function* () {
        yield* assertScopeAccess(path.scopeId);
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            yield* executor.secrets.remove(path.secretId);
            return { removed: true };
          }),
        );
      }),
    ),
);
