// ---------------------------------------------------------------------------
// HTTP API middleware — live implementations (server-only).
// Imports the WorkOS SDK so it must NOT be pulled into the client bundle.
// ---------------------------------------------------------------------------

import { Effect, Layer, Redacted } from "effect";

import { NoOrganization, OrgAuth, SessionAuth, Unauthorized } from "./middleware";
import { WorkOSAuth } from "./workos";

export const SessionAuthLive = Layer.effect(
  SessionAuth,
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    return SessionAuth.of({
      cookie: (sealedSession) =>
        Effect.gen(function* () {
          const result = yield* workos
            .authenticateSealedSession(Redacted.value(sealedSession))
            .pipe(Effect.orElseSucceed(() => null));

          if (!result) {
            return yield* new Unauthorized();
          }

          return {
            accountId: result.userId,
            email: result.email,
            name: `${result.firstName ?? ""} ${result.lastName ?? ""}`.trim() || null,
            avatarUrl: result.avatarUrl ?? null,
            organizationId: result.organizationId ?? null,
            sealedSession: result.refreshedSession ?? Redacted.value(sealedSession),
            refreshedSession: result.refreshedSession ?? null,
          };
        }),
    });
  }),
);

export const OrgAuthLive = Layer.effect(
  OrgAuth,
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    return OrgAuth.of({
      cookie: (sealedSession) =>
        Effect.gen(function* () {
          const result = yield* workos
            .authenticateSealedSession(Redacted.value(sealedSession))
            .pipe(Effect.orElseSucceed(() => null));

          if (!result) {
            return yield* new Unauthorized();
          }

          if (!result.organizationId) {
            return yield* new NoOrganization();
          }

          return {
            accountId: result.userId,
            organizationId: result.organizationId,
            email: result.email,
            name: `${result.firstName ?? ""} ${result.lastName ?? ""}`.trim() || null,
            avatarUrl: result.avatarUrl ?? null,
          };
        }),
    });
  }),
);
