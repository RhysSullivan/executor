// ---------------------------------------------------------------------------
// Organization lookup — local mirror with lazy WorkOS fallback.
// ---------------------------------------------------------------------------
//
// We keep a minimal local mirror of organizations so domain tables can
// foreign-key against them and so we don't hit WorkOS on every request.
// But the mirror can drift: a user's session can reference an org that was
// created outside this app (or before the mirror existed). Rather than
// proactively mirroring on every login — which was the source of the messy
// callback flow we just untangled — we mirror lazily the first time an
// unknown org is read. All other callers just do `getOrganization` and get
// a self-healing lookup for free.

import { Effect } from "effect";

import { UserStoreService } from "./context";
import { WorkOSAuth } from "./workos";

export const resolveOrganization = (organizationId: string) =>
  Effect.gen(function* () {
    const users = yield* UserStoreService;
    const existing = yield* users.use((s) => s.getOrganization(organizationId));
    if (existing) return existing;

    const workos = yield* WorkOSAuth;
    const fresh = yield* workos.getOrganization(organizationId);
    return yield* users.use((s) => s.upsertOrganization({ id: fresh.id, name: fresh.name }));
  });
