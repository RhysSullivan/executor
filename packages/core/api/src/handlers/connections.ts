import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { capture } from "@executor/api";
import type { ConnectionRef } from "@executor/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";

const refToResponse = (ref: ConnectionRef) => ({
  id: ref.id,
  scopeId: ref.scopeId,
  provider: ref.provider,
  identityLabel: ref.identityLabel,
  accessTokenSecretId: ref.accessTokenSecretId,
  refreshTokenSecretId: ref.refreshTokenSecretId,
  expiresAt: ref.expiresAt,
  oauthScope: ref.oauthScope,
  createdAt: ref.createdAt.getTime(),
  updatedAt: ref.updatedAt.getTime(),
});

export const ConnectionsHandlers = HttpApiBuilder.group(
  ExecutorApi,
  "connections",
  (handlers) =>
    handlers
      .handle("list", () =>
        capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const refs = yield* executor.connections.list();
            return refs.map(refToResponse);
          }),
        ),
      )
      .handle("remove", ({ path }) =>
        capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            yield* executor.connections.remove(path.connectionId);
            return { removed: true };
          }),
        ),
      ),
);
