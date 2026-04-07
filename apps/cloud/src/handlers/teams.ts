// ---------------------------------------------------------------------------
// Team handlers — members, invitations
// ---------------------------------------------------------------------------

import { makeUserStore } from "@executor/storage-postgres";
import { authenticateRequest } from "../auth/workos";
import type { DrizzleDb } from "../services/db";

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.slice(name.length + 1) || null;
};

export const createTeamHandlers = (db: DrizzleDb) => {
  const userStore = makeUserStore(db);

  const requireAuth = async (request: Request) => {
    const auth = await authenticateRequest(request);
    if (!auth) return null;
    const teamId = parseCookie(request.headers.get("cookie"), "executor_team");
    if (!teamId) return null;
    return { ...auth, teamId };
  };

  return {
    listMembers: async (request: Request): Promise<Response> => {
      const auth = await requireAuth(request);
      if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const members = await userStore.listMembers(auth.teamId);
      return Response.json({ members });
    },

    invite: async (request: Request): Promise<Response> => {
      const auth = await requireAuth(request);
      if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const body = await request.json() as { email: string };
      if (!body.email) {
        return Response.json({ error: "Email required" }, { status: 400 });
      }

      const invitation = await userStore.createInvitation(
        auth.teamId,
        body.email,
        auth.userId,
      );
      return Response.json({ invitation });
    },

    listInvitations: async (request: Request): Promise<Response> => {
      const auth = await requireAuth(request);
      if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const invitations = await userStore.getTeamInvitations(auth.teamId);
      return Response.json({ invitations });
    },

    removeMember: async (request: Request): Promise<Response> => {
      const auth = await requireAuth(request);
      if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const body = await request.json() as { userId: string };
      if (!body.userId) {
        return Response.json({ error: "userId required" }, { status: 400 });
      }

      if (body.userId === auth.userId) {
        return Response.json({ error: "Cannot remove yourself" }, { status: 400 });
      }

      await userStore.removeMember(auth.teamId, body.userId);
      return Response.json({ removed: true });
    },
  };
};
