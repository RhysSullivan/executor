// ---------------------------------------------------------------------------
// HTTP API middleware — live implementations (server-only).
// Imports the WorkOS SDK so it must NOT be pulled into the client bundle.
// ---------------------------------------------------------------------------

import { Effect, Layer, Redacted } from "effect";

import {
  AuthContext,
  NoOrganization,
  OrgAuth,
  SessionAuth,
  SessionContext,
  Unauthorized,
} from "./middleware";
import { WorkOSAuth } from "./workos";

export const SessionAuthLive = Layer.effect(
  SessionAuth,
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    return {
      cookie: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const result = yield* workos
            .authenticateSealedSession(Redacted.value(credential))
            .pipe(Effect.orElseSucceed(() => null));

          if (!result) {
            return yield* Effect.fail(new Unauthorized());
          }

          const session = {
            accountId: result.userId,
            email: result.email,
            name: `${result.firstName ?? ""} ${result.lastName ?? ""}`.trim() || null,
            avatarUrl: result.avatarUrl ?? null,
            organizationId: result.organizationId ?? null,
            sealedSession: result.refreshedSession ?? Redacted.value(credential),
            refreshedSession: result.refreshedSession ?? null,
          };

          return yield* Effect.provideService(httpEffect, SessionContext, session);
        }),
    };
  }),
);

export const OrgAuthLive = Layer.effect(
  OrgAuth,
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    return {
      cookie: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const result = yield* workos
            .authenticateSealedSession(Redacted.value(credential))
            .pipe(Effect.orElseSucceed(() => null));

          if (!result) {
            return yield* Effect.fail(new Unauthorized());
          }

          if (!result.organizationId) {
            return yield* Effect.fail(new NoOrganization());
          }

          const auth = {
            accountId: result.userId,
            organizationId: result.organizationId,
            email: result.email,
            name: `${result.firstName ?? ""} ${result.lastName ?? ""}`.trim() || null,
            avatarUrl: result.avatarUrl ?? null,
          };

          return yield* Effect.provideService(httpEffect, AuthContext, auth);
        }),
    };
  }),
);
