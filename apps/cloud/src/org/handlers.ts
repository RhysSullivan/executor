import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { UserStoreService } from "../auth/context";
import { AuthContext } from "../auth/middleware";
import { env } from "cloudflare:workers";
import { WorkOSAuth } from "../auth/workos";
import { AutumnService } from "../services/autumn";
import { OrgHttpApi } from "./compose";
import { Forbidden } from "./api";

const requireAdmin = Effect.gen(function* () {
  const auth = yield* AuthContext;
  const workos = yield* WorkOSAuth;
  const memberships = yield* workos.listOrgMembers(auth.organizationId);
  const currentMembership = memberships.data.find((m) => m.userId === auth.accountId);
  if (!currentMembership || currentMembership.role?.slug !== "admin") {
    return yield* new Forbidden();
  }
});

// Target-ownership checks — independent of caller privilege. `requireAdmin`
// confirms the caller is an admin of their session's org; these confirm the
// resource they're about to mutate actually lives in that same org. Without
// this, an admin of org A who obtained a membership/domain id from org B
// (leak, screenshot, support context) could trigger the WorkOS SDK against
// org B's resource — the workspace API key is workspace-wide and WorkOS
// does not enforce per-org ownership on delete/update by id. Failures
// (not found OR org mismatch) both surface as Forbidden so we don't leak
// existence of ids outside the caller's org.
const assertMembershipInSessionOrg = (membershipId: string) =>
  Effect.gen(function* () {
    const auth = yield* AuthContext;
    const workos = yield* WorkOSAuth;
    const membership = yield* workos
      .getOrgMembership(membershipId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (!membership || membership.organizationId !== auth.organizationId) {
      return yield* new Forbidden();
    }
  });

const assertDomainInSessionOrg = (domainId: string) =>
  Effect.gen(function* () {
    const auth = yield* AuthContext;
    const workos = yield* WorkOSAuth;
    const domain = yield* workos
      .getOrganizationDomain(domainId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (!domain || domain.organizationId !== auth.organizationId) {
      return yield* new Forbidden();
    }
  });

export const OrgHandlers = HttpApiBuilder.group(OrgHttpApi, "org", (handlers) =>
  handlers
    .handle("listMembers", () =>
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        const workos = yield* WorkOSAuth;

        const memberships = yield* workos.listOrgMembers(auth.organizationId);

        const members = yield* Effect.all(
          memberships.data.map((m) =>
            Effect.gen(function* () {
              const user = yield* workos.getUser(m.userId);
              return {
                id: m.id,
                userId: m.userId,
                email: user.email,
                name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
                avatarUrl: user.profilePictureUrl ?? null,
                role: m.role?.slug ?? "member",
                status: m.status,
                lastActiveAt: user.lastSignInAt ?? null,
                isCurrentUser: m.userId === auth.accountId,
              };
            }),
          ),
          { concurrency: 5 },
        );

        return { members };
      }),
    )
    .handle("listRoles", () =>
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        const workos = yield* WorkOSAuth;

        const result = yield* workos.listOrgRoles(auth.organizationId);

        return {
          roles: result.data.map((r) => ({
            slug: r.slug,
            name: r.name,
          })),
        };
      }),
    )
    .handle("invite", ({ payload }) =>
      Effect.gen(function* () {
        yield* requireAdmin;
        const auth = yield* AuthContext;
        const workos = yield* WorkOSAuth;

        const invitation = yield* workos.sendInvitation({
          email: payload.email,
          organizationId: auth.organizationId,
          roleSlug: payload.roleSlug,
        });

        return { id: invitation.id, email: invitation.email };
      }),
    )
    .handle("removeMember", ({ path }) =>
      Effect.gen(function* () {
        yield* requireAdmin;
        yield* assertMembershipInSessionOrg(path.membershipId);
        const workos = yield* WorkOSAuth;
        yield* workos.deleteOrgMembership(path.membershipId);
        return { success: true };
      }),
    )
    .handle("updateMemberRole", ({ path, payload }) =>
      Effect.gen(function* () {
        yield* requireAdmin;
        yield* assertMembershipInSessionOrg(path.membershipId);
        const workos = yield* WorkOSAuth;
        yield* workos.updateOrgMembershipRole(path.membershipId, payload.roleSlug);
        return { success: true };
      }),
    )
    .handle("listDomains", () =>
      Effect.gen(function* () {
        const auth = yield* AuthContext;
        const workos = yield* WorkOSAuth;
        const org = yield* workos.getOrganization(auth.organizationId);

        const domains = yield* Effect.all(
          org.domains.map((d) =>
            Effect.gen(function* () {
              const full = yield* workos.getOrganizationDomain(d.id);
              return {
                id: full.id,
                domain: full.domain,
                state: full.state,
                verificationToken: full.verificationToken,
                verificationPrefix: full.verificationPrefix,
              };
            }),
          ),
          { concurrency: 5 },
        );

        return { domains };
      }),
    )
    .handle("getDomainVerificationLink", () =>
      Effect.gen(function* () {
        yield* requireAdmin;
        const auth = yield* AuthContext;

        const autumn = yield* AutumnService;
        const check = yield* autumn
          .use((client) =>
            client.check({
              customerId: auth.organizationId,
              featureId: "domain-verification",
            }),
          )
          .pipe(Effect.orElseSucceed(() => ({ allowed: true })));

        if (!check.allowed) {
          return yield* new Forbidden();
        }

        const workos = yield* WorkOSAuth;
        const { link } = yield* workos.generateDomainVerificationPortalLink(
          auth.organizationId,
          env.VITE_PUBLIC_SITE_URL ? `${env.VITE_PUBLIC_SITE_URL}/org` : "/org",
        );
        return { link };
      }),
    )
    .handle("deleteDomain", ({ path }) =>
      Effect.gen(function* () {
        yield* requireAdmin;
        yield* assertDomainInSessionOrg(path.domainId);
        const workos = yield* WorkOSAuth;
        yield* workos.deleteOrganizationDomain(path.domainId);
        return { success: true };
      }),
    )
    .handle("updateOrgName", ({ payload }) =>
      Effect.gen(function* () {
        yield* requireAdmin;
        const auth = yield* AuthContext;
        const workos = yield* WorkOSAuth;
        const users = yield* UserStoreService;
        const org = yield* workos.updateOrganization(auth.organizationId, payload.name);
        yield* users.use((s) => s.upsertOrganization({ id: org.id, name: org.name }));
        return { name: org.name };
      }),
    ),
);
