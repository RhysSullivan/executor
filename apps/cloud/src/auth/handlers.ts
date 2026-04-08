import { HttpApi, HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { deleteCookie, setCookie } from "@tanstack/react-start/server";

import { addGroup } from "@executor/api";
import { AUTH_PATHS, CloudAuthApi, CloudAuthPublicApi } from "./api";
import { AuthContext, UserStoreService } from "./context";
import { WorkOSAuth } from "./workos";

const COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 7,
  secure: process.env.NODE_ENV === "production",
};

// ---------------------------------------------------------------------------
// Public auth handlers (no authentication required)
// ---------------------------------------------------------------------------

const PublicAuthApi = HttpApi.make("cloudPublic")
  .add(CloudAuthPublicApi);

export const CloudAuthPublicHandlers = HttpApiBuilder.group(
  PublicAuthApi,
  "cloudAuthPublic",
  (handlers) =>
    handlers
      .handleRaw("login", () =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const req = yield* HttpServerRequest.HttpServerRequest;
          const origin = new URL(req.url, `http://${req.headers["host"]}`).origin;
          const url = workos.getAuthorizationUrl(`${origin}${AUTH_PATHS.callback}`);
          return HttpServerResponse.redirect(url, { status: 302 });
        }),
      )
      .handleRaw("callback", ({ urlParams }) =>
        Effect.gen(function* () {
          const workos = yield* WorkOSAuth;
          const users = yield* UserStoreService;

          const result = yield* workos.authenticateWithCode(urlParams.code);
          const workosUser = result.user;

          const user = yield* users.use((s) =>
            s.upsertUser({
              id: workosUser.id,
              email: workosUser.email,
              name: `${workosUser.firstName ?? ""} ${workosUser.lastName ?? ""}`.trim() || undefined,
              avatarUrl: workosUser.profilePictureUrl ?? undefined,
            }),
          );

          const resolveTeam = Effect.gen(function* () {
            const pending = yield* users.use((s) => s.getPendingInvitations(user.email));
            if (pending.length > 0) {
              const invitation = pending[0]!;
              yield* users.use((s) => s.acceptInvitation(invitation.id));
              yield* users.use((s) => s.addMember(invitation.teamId, user.id, "member"));
              return invitation.teamId;
            }

            const teams = yield* users.use((s) => s.getTeamsForUser(user.id));
            if (teams.length > 0) return teams[0]!.teamId;

            const team = yield* users.use((s) =>
              s.createTeam(`${user.name ?? user.email}'s Team`),
            );
            yield* users.use((s) => s.addMember(team.id, user.id, "owner"));
            return team.id;
          });

          const teamId = yield* resolveTeam;

          const sealedSession = result.sealedSession;
          if (!sealedSession) {
            return HttpServerResponse.text("Failed to create session", { status: 500 });
          }

          setCookie("wos-session", sealedSession, COOKIE_OPTIONS);
          setCookie("executor_team", teamId, COOKIE_OPTIONS);
          return HttpServerResponse.redirect("/", { status: 302 });
        }),
      ),
);

// ---------------------------------------------------------------------------
// Protected auth handlers (require authentication via middleware)
// ---------------------------------------------------------------------------

const ApiWithCloudAuth = addGroup(CloudAuthApi);

export const CloudAuthHandlers = HttpApiBuilder.group(
  ApiWithCloudAuth,
  "cloudAuth",
  (handlers) =>
    handlers
      .handle("me", () =>
        Effect.gen(function* () {
          const auth = yield* AuthContext;
          const users = yield* UserStoreService;
          const team = yield* users.use((s) => s.getTeam(auth.teamId));

          return {
            user: {
              id: auth.userId,
              email: auth.email,
              name: auth.name,
              avatarUrl: auth.avatarUrl,
            },
            team: team ? { id: team.id, name: team.name } : null,
          };
        }),
      )
      .handleRaw("logout", () =>
        Effect.sync(() => {
          deleteCookie("wos-session", { path: "/" });
          deleteCookie("executor_team", { path: "/" });
          return HttpServerResponse.redirect("/", { status: 302 });
        }),
      ),
);
