import { HttpApi, HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { setCookie, deleteCookie } from "@tanstack/react-start/server";

import { AUTH_PATHS, CloudAuthApi, CloudAuthPublicApi } from "./api";
import { SessionContext } from "./middleware";
import { UserStoreService } from "./context";
import { authorizeOrganization } from "./authorize-organization";
import { resolveOrganization } from "./resolve-organization";
import { WorkOSError } from "./errors";
import { WorkOSAuth } from "./workos";
import { server } from "../env";

const COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 7,
  secure: true,
};

// ---------------------------------------------------------------------------
// Single non-protected API surface — public (login/callback) + session
// (me/logout/organizations/switch-organization). The session group has SessionAuth on it.
// ---------------------------------------------------------------------------

export const NonProtectedApi = HttpApi.make("cloudWeb").add(CloudAuthPublicApi).add(CloudAuthApi);

// ---------------------------------------------------------------------------
// Public auth handlers (no authentication required)
// ---------------------------------------------------------------------------

export const CloudAuthPublicHandlers = HttpApiBuilder.group(
  NonProtectedApi,
  "cloudAuthPublic",
  (handlers) =>
    handlers
      .handleRaw("login", () =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          // Use the explicit public site URL — in dev, the request's Host
          // header points at the internal proxy target, not the public URL
          // WorkOS needs to redirect back to.
          const origin = server.VITE_PUBLIC_SITE_URL;
          const url = workos.getAuthorizationUrl(`${origin}${AUTH_PATHS.callback}`);
          return HttpServerResponse.redirect(url, { status: 302 });
        }),
      )
      .handleRaw("callback", ({ urlParams }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const users = yield* UserStoreService;

          const result = yield* workos.authenticateWithCode(urlParams.code);

          // Mirror the account locally
          yield* users.use((s) => s.ensureAccount(result.user.id));

          let sealedSession = result.sealedSession;

          // If the auth response didn't surface an org but the user already
          // belongs to one, rehydrate the session with it. If they have no
          // memberships at all, leave the session org-less — the frontend
          // AuthGate will render the onboarding flow. We never auto-create
          // organizations on login.
          let activeOrgId = result.organizationId ?? null;
          if (!result.organizationId && sealedSession) {
            const memberships = yield* workos.listUserMemberships(result.user.id);
            const existing = memberships.data[0];
            if (existing) {
              const refreshed = yield* workos.refreshSession(
                sealedSession,
                existing.organizationId,
              );
              if (refreshed) {
                sealedSession = refreshed;
                activeOrgId = existing.organizationId;
              }
            }
          }

          if (!sealedSession) {
            return HttpServerResponse.text("Failed to create session", { status: 500 });
          }

          setCookie("wos-session", sealedSession, COOKIE_OPTIONS);
          // Land the user directly on their active org's scoped URL. If we
          // can't resolve a slug (no active org yet), fall back to root —
          // the frontend AuthGate will render the onboarding flow from
          // there and redirect out once an org exists.
          const target = activeOrgId
            ? yield* resolveOrganization(activeOrgId).pipe(
                Effect.map((org) => `/${org.slug}/`),
                Effect.orElseSucceed(() => "/"),
              )
            : "/";
          return HttpServerResponse.redirect(target, { status: 302 });
        }),
      ),
);

// ---------------------------------------------------------------------------
// Session auth handlers (require session, may or may not have an org)
// ---------------------------------------------------------------------------

export const CloudSessionAuthHandlers = HttpApiBuilder.group(
  NonProtectedApi,
  "cloudAuth",
  (handlers) =>
    handlers
      .handle("me", () =>
        Effect.gen(function* () {
          const session = yield* SessionContext;
          const org = session.organizationId
            ? yield* authorizeOrganization(session.accountId, session.organizationId)
            : null;

          return {
            user: {
              id: session.accountId,
              email: session.email,
              name: session.name,
              avatarUrl: session.avatarUrl,
            },
            organization: org ? { id: org.id, slug: org.slug, name: org.name } : null,
          };
        }),
      )
      .handleRaw("logout", () => {
        deleteCookie("wos-session", { path: "/" });
        return Effect.succeed(HttpServerResponse.redirect("/", { status: 302 }));
      })
      .handle("organizations", () =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const session = yield* SessionContext;

          const memberships = yield* workos.listUserMemberships(session.accountId);
          const organizations = yield* Effect.all(
            memberships.data.map((m) =>
              resolveOrganization(m.organizationId).pipe(
                Effect.map((org) => ({ id: org.id, slug: org.slug, name: org.name })),
                Effect.orElseSucceed(() => null),
              ),
            ),
            { concurrency: "unbounded" },
          );

          return {
            organizations: organizations.filter((org): org is NonNullable<typeof org> => org !== null),
            activeOrganizationId: session.organizationId,
          };
        }),
      )
      .handle("switchOrganization", ({ payload }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const session = yield* SessionContext;

          const refreshed = yield* workos.refreshSession(
            session.sealedSession,
            payload.organizationId,
          );
          if (refreshed) {
            setCookie("wos-session", refreshed, COOKIE_OPTIONS);
          }
        }),
      )
      .handle("createOrganization", ({ payload }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const users = yield* UserStoreService;
          const session = yield* SessionContext;

          const name = payload.name.trim();
          const org = yield* workos.createOrganization(name);
          yield* workos.createMembership(org.id, session.accountId, "admin");
          const stored = yield* users.use((s) =>
            s.upsertOrganization({ id: org.id, name: org.name }),
          );

          // Try to attach the new org to the current session. This can fail
          // (or silently return a session still scoped to the old org) when
          // the caller's current session is stale — most commonly after the
          // user was removed from the org their cookie is pinned to. In that
          // case we can't repair the session in-place, so we clear the
          // cookie and fail loudly; the frontend will bounce to login and
          // the callback's rehydrate path will pick up the new membership.
          const refreshed = yield* workos.refreshSession(session.sealedSession, org.id);
          const verified = refreshed
            ? yield* workos.authenticateSealedSession(refreshed)
            : null;

          if (!refreshed || !verified || verified.organizationId !== org.id) {
            yield* Effect.logWarning(
              "createOrganization: unable to attach new org to current session",
              {
                userId: session.accountId,
                newOrgId: org.id,
                refreshReturnedSession: refreshed != null,
                verifiedOrgId: verified?.organizationId ?? null,
              },
            );
            deleteCookie("wos-session", { path: "/" });
            return yield* new WorkOSError();
          }

          setCookie("wos-session", refreshed, COOKIE_OPTIONS);
          return { id: stored.id, slug: stored.slug, name: stored.name };
        }),
      ),
);
