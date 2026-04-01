import { HttpApiBuilder } from "@effect/platform";
import { Effect, Option } from "effect";
import type { SecretId, ScopeId } from "@executor/sdk";

import { ExecutorApi } from "@executor/api";
import { ExecutorService } from "../services/executor";

const refToResponse = (ref: {
  id: SecretId;
  scopeId: ScopeId;
  name: string;
  provider: Option.Option<string>;
  purpose?: string;
  createdAt: Date;
}) => ({
  id: ref.id,
  scopeId: ref.scopeId,
  name: ref.name,
  provider: Option.getOrUndefined(ref.provider),
  purpose: ref.purpose,
  createdAt: ref.createdAt.getTime(),
});

export const SecretsHandlers = HttpApiBuilder.group(
  ExecutorApi,
  "secrets",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const refs = yield* executor.secrets.list();
          return refs.map(refToResponse);
        }),
      )
      .handle("status", ({ path }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const status = yield* executor.secrets.status(path.secretId);
          return { secretId: path.secretId, status };
        }),
      )
      .handle("set", ({ path, payload }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const ref = yield* executor.secrets.set({
            id: payload.id,
            name: payload.name,
            value: payload.value,
            purpose: payload.purpose,
            provider: payload.provider,
          });
          return refToResponse(ref);
        }),
      )
      .handle("remove", ({ path }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const removed = yield* executor.secrets.remove(path.secretId);
          return { removed };
        }),
      ),
);
