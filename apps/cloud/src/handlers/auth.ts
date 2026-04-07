// ---------------------------------------------------------------------------
// Auth handlers — login, callback, logout, me
// ---------------------------------------------------------------------------

import { makeUserStore } from "@executor/storage-postgres";
import {
  getAuthorizationUrl,
  authenticateWithCode,
  authenticateRequest,
  getLogoutUrl,
  makeSessionCookie,
  clearSessionCookie,
} from "../auth/workos";
import type { DrizzleDb } from "../services/db";

export const createAuthHandlers = (db: DrizzleDb) => {
  const userStore = makeUserStore(db);

  const getBaseUrl = (): string => {
    if (process.env.APP_URL) return process.env.APP_URL;
    const port = process.env.PORT ?? "3000";
    return `http://localhost:${port}`;
  };

  return {
    login: async (_request: Request): Promise<Response> => {
      const redirectUri = `${getBaseUrl()}/auth/callback`;
      const url = getAuthorizationUrl(redirectUri);
      return Response.redirect(url, 302);
    },

    callback: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("Missing code parameter", { status: 400 });
      }

      try {
        const result = await authenticateWithCode(code);
        const workosUser = result.user;

        // Upsert user
        const user = await userStore.upsertUser({
          id: workosUser.id,
          email: workosUser.email,
          name: `${workosUser.firstName ?? ""} ${workosUser.lastName ?? ""}`.trim() || undefined,
          avatarUrl: workosUser.profilePictureUrl ?? undefined,
        });

        // Check for pending invitations
        const pendingInvitations = await userStore.getPendingInvitations(user.email);
        let teamId: string;

        if (pendingInvitations.length > 0) {
          const invitation = pendingInvitations[0]!;
          await userStore.acceptInvitation(invitation.id);
          await userStore.addMember(invitation.teamId, user.id, "member");
          teamId = invitation.teamId;
        } else {
          const teams = await userStore.getTeamsForUser(user.id);
          if (teams.length > 0) {
            teamId = teams[0]!.teamId;
          } else {
            const team = await userStore.createTeam(`${user.name ?? user.email}'s Team`);
            await userStore.addMember(team.id, user.id, "owner");
            teamId = team.id;
          }
        }

        // Store teamId in a separate cookie (WorkOS sealed session doesn't carry app-specific data)
        const sealedSession = result.sealedSession;
        if (!sealedSession) {
          return new Response("Failed to create session", { status: 500 });
        }

        return new Response(null, {
          status: 302,
          headers: [
            ["Location", "/"],
            ["Set-Cookie", makeSessionCookie(sealedSession)],
            ["Set-Cookie", `executor_team=${teamId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`],
          ],
        });
      } catch (error) {
        console.error("Auth callback error:", error);
        return new Response("Authentication failed", { status: 500 });
      }
    },

    logout: async (request: Request): Promise<Response> => {
      const logoutUrl = await getLogoutUrl(request);
      const headers: [string, string][] = [
        ["Set-Cookie", clearSessionCookie()],
        ["Set-Cookie", "executor_team=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
      ];

      if (logoutUrl) {
        headers.push(["Location", logoutUrl]);
        return new Response(null, { status: 302, headers });
      }

      headers.push(["Location", "/login"]);
      return new Response(null, { status: 302, headers });
    },

    me: async (request: Request): Promise<Response> => {
      const auth = await authenticateRequest(request);
      if (!auth) {
        return Response.json({ error: "Not authenticated" }, { status: 401 });
      }

      const user = await userStore.getUser(auth.userId);
      if (!user) {
        return Response.json({ error: "User not found" }, { status: 401 });
      }

      // Read teamId from cookie
      const teamId = parseCookie(request.headers.get("cookie"), "executor_team");
      const team = teamId ? await userStore.getTeam(teamId) : null;

      return Response.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
        team: team ? { id: team.id, name: team.name } : null,
      });
    },
  };
};

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.slice(name.length + 1) || null;
};
