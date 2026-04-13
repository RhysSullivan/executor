import { HttpApi, HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { setCookie, deleteCookie } from "@tanstack/react-start/server";

import { AUTH_PATHS, CloudAuthApi, CloudAuthPublicApi } from "./api";
import { SessionContext } from "./middleware";
import { UserStoreService } from "./context";
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
          let organizationId = result.organizationId;

          // If the auth response doesn't include an org, check if the user
          // already belongs to one. Only create a new organization if they truly
          // have no memberships — this prevents duplicate orgs on re-login.
          if (!organizationId) {
            const memberships = yield* workos.listUserMemberships(result.user.id);
            const existing = memberships.data[0];

            if (existing) {
              organizationId = existing.organizationId;
            } else {
              const name =
                [result.user.firstName, result.user.lastName].filter(Boolean).join(" ") ||
                result.user.email;
              const org = yield* workos.createOrganization(`${name}'s Organization`);
              yield* workos.createMembership(org.id, result.user.id, "admin");
              yield* users.use((s) => s.upsertOrganization({ id: org.id, name: org.name }));
              organizationId = org.id;
            }

            // Refresh the session so it includes the org context
            if (sealedSession) {
              const refreshed = yield* workos.refreshSession(sealedSession, organizationId);
              if (refreshed) sealedSession = refreshed;
            }
          } else {
            const org = yield* workos.getOrganization(organizationId!);
            yield* users.use((s) =>
              s.upsertOrganization({
                id: organizationId!,
                name: org.name,
              }),
            );
          }

          if (!sealedSession) {
            return HttpServerResponse.text("Failed to create session", { status: 500 });
          }

          setCookie("wos-session", sealedSession, COOKIE_OPTIONS);
          return HttpServerResponse.redirect("/", { status: 302 });
        }).pipe(
          Effect.catchTags({
            WorkOSError: () => Effect.succeed(HttpServerResponse.redirect("/", { status: 302 })),
            UserStoreError: () => Effect.succeed(HttpServerResponse.redirect("/", { status: 302 })),
          }),
        ),
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
          const users = yield* UserStoreService;
          const org = session.organizationId
            ? yield* users.use((s) => s.getOrganization(session.organizationId!))
            : null;

          return {
            user: {
              id: session.accountId,
              email: session.email,
              name: session.name,
              avatarUrl: session.avatarUrl,
            },
            organization: org ? { id: org.id, name: org.name } : null,
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
              workos.getOrganization(m.organizationId).pipe(
                Effect.map((org) => ({ id: org.id, name: org.name })),
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
          yield* users.use((s) => s.upsertOrganization({ id: org.id, name: org.name }));

          const refreshed = yield* workos.refreshSession(session.sealedSession, org.id);
          if (refreshed) {
            setCookie("wos-session", refreshed, COOKIE_OPTIONS);
          }

          return { id: org.id, name: org.name };
        }),
      ),
);
