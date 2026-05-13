// ---------------------------------------------------------------------------
// Organization authorization — live membership check against WorkOS.
// ---------------------------------------------------------------------------
//
// The sealed session cookie carries an organizationId that WorkOS signed at
// login / refresh time. WorkOS does NOT invalidate existing sessions when a
// membership is revoked, and `session.authenticate()` validates the JWT
// locally without hitting the API — so a removed user keeps full access
// until their access token naturally expires (~10 min).
//
// To close that gap we verify membership live on every protected request.
// `listUserMemberships` is one WorkOS call per request. If this becomes a
// hot path we can layer a short per-(user, org) TTL cache underneath, or
// swap it for a local memberships table fed by the WorkOS Events API.
//
// Returns the resolved organization (via resolveOrganization) if the user
// currently holds an *active* membership in it, otherwise null. Callers
// should treat null as "no access" and route accordingly (onboarding page /
// 403).

import { Effect } from "effect";

import { resolveOrganization } from "./resolve-organization";
import { WorkOSAuth } from "./workos";

export const authorizeOrganization = (userId: string, organizationId: string) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    const memberships = yield* workos.listUserMemberships(userId);
    const active = memberships.data.find(
      (m: { readonly organizationId: string; readonly status: string }) =>
        m.organizationId === organizationId && m.status === "active",
    );
    if (!active) return null;

    return yield* resolveOrganization(organizationId);
  });
