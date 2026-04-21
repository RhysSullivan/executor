import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import type { ConnectionRef } from "@executor/sdk";

import { capture } from "@executor/api";
import { ExecutorService } from "@executor/api/server";

import { assertScopeAccess } from "../../auth/scope-access";
import { ProtectedCloudApi } from "../api";

const refToResponse = (ref: ConnectionRef) => ({
  id: ref.id,
  scopeId: ref.scopeId,
  provider: ref.provider,
  kind: ref.kind,
  identityLabel: ref.identityLabel,
  accessTokenSecretId: ref.accessTokenSecretId,
  refreshTokenSecretId: ref.refreshTokenSecretId,
  expiresAt: ref.expiresAt,
  oauthScope: ref.oauthScope,
  createdAt: ref.createdAt.getTime(),
  updatedAt: ref.updatedAt.getTime(),
});

export const ConnectionsHandlers = HttpApiBuilder.group(
  ProtectedCloudApi,
  "connections",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          yield* assertScopeAccess(path.scopeId);
          return yield* capture(
            Effect.gen(function* () {
              const executor = yield* ExecutorService;
              const refs = yield* executor.connections.list();
              return refs.map(refToResponse);
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
              yield* executor.connections.remove(path.connectionId);
              return { removed: true };
            }),
          );
        }),
      ),
);
