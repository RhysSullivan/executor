// ---------------------------------------------------------------------------
// Executor Cloud — main entry point
//
// Single Bun.serve() routing:
//   /auth/*     → Auth handlers (login, callback, logout, me)
//   /api/team/* → Team handlers (members, invitations)
//   /v1/*       → Effect HTTP API (tools, sources, secrets, executions)
//   /docs       → OpenAPI docs
//   /*          → Static frontend (SPA)
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import { getDb } from "./services/db";
import { createAuthHandlers } from "./handlers/auth";
import { createTeamHandlers } from "./handlers/teams";
import { createCloudApiHandler } from "./api";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "local-dev-encryption-key";

// ---------------------------------------------------------------------------
// Initialize services
// ---------------------------------------------------------------------------

const db = await getDb();
const authHandlers = createAuthHandlers(db);
const teamHandlers = createTeamHandlers(db);
const apiHandler = createCloudApiHandler(db, ENCRYPTION_KEY);

// ---------------------------------------------------------------------------
// Static file serving (frontend)
// ---------------------------------------------------------------------------

const WEB_DIST_DIR = resolve(import.meta.dirname, "../dist");

const serveStatic = async (pathname: string): Promise<Response | null> => {
  const key = pathname.replace(/^\//, "");
  const filePath = resolve(WEB_DIST_DIR, key);
  if (!filePath.startsWith(WEB_DIST_DIR)) return null;

  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "content-type": file.type || "application/octet-stream" },
    });
  }

  // SPA fallback
  const index = Bun.file(resolve(WEB_DIST_DIR, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "content-type": "text/html" } });
  }

  return null;
};

// ---------------------------------------------------------------------------
// Main server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // --- Auth routes (public) ---
    if (url.pathname === "/auth/login") return authHandlers.login(request);
    if (url.pathname === "/auth/callback") return authHandlers.callback(request);
    if (url.pathname === "/auth/logout") return authHandlers.logout(request);
    if (url.pathname === "/auth/me") return authHandlers.me(request);

    // --- Team routes (authenticated) ---
    if (url.pathname === "/api/team/members" && request.method === "GET")
      return teamHandlers.listMembers(request);
    if (url.pathname === "/api/team/members" && request.method === "DELETE")
      return teamHandlers.removeMember(request);
    if (url.pathname === "/api/team/invite" && request.method === "POST")
      return teamHandlers.invite(request);
    if (url.pathname === "/api/team/invitations" && request.method === "GET")
      return teamHandlers.listInvitations(request);

    // --- Effect HTTP API (authenticated) ---
    if (
      url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/docs") ||
      url.pathname === "/openapi.json"
    ) {
      return apiHandler(request);
    }

    // --- Static frontend ---
    const staticResponse = await serveStatic(url.pathname);
    if (staticResponse) return staticResponse;

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Executor Cloud running on http://localhost:${server.port}`);
