import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Env = {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthProvider;
};

type OAuthProps = {
  email: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// MCP server factory — creates a fresh server per request
// ---------------------------------------------------------------------------

function createMcpServer(db: D1Database) {
  const server = new McpServer({ name: "d1-mcp-demo", version: "1.0.0" });

  server.tool("list-notes", "List all notes", {}, async () => {
    const { results } = await db
      .prepare("SELECT id, content, created_at FROM notes ORDER BY created_at DESC")
      .all<{ id: number; content: string; created_at: string }>();

    return {
      content: [
        {
          type: "text" as const,
          text:
            results.length === 0
              ? "No notes yet."
              : results.map((r) => `[${r.id}] ${r.content} (${r.created_at})`).join("\n"),
        },
      ],
    };
  });

  server.tool(
    "add-note",
    "Add a new note",
    { content: z.string().describe("The note content") },
    async ({ content }) => {
      const result = await db
        .prepare("INSERT INTO notes (content) VALUES (?) RETURNING id")
        .bind(content)
        .first<{ id: number }>();

      return {
        content: [{ type: "text" as const, text: `Note added with id ${result!.id}` }],
      };
    },
  );

  server.tool(
    "delete-note",
    "Delete a note by ID",
    { id: z.number().describe("The note ID to delete") },
    async ({ id }) => {
      const { meta } = await db.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
      return {
        content: [
          {
            type: "text" as const,
            text: meta.changes > 0 ? `Deleted note ${id}` : `Note ${id} not found`,
          },
        ],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// MCP request handler (called by OAuthProvider for authenticated /mcp requests)
// ---------------------------------------------------------------------------

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: OAuthProps }): Promise<Response> {
    const server = createMcpServer(env.DB);
    const handler = createMcpHandler(server, { route: "/mcp" });
    return handler(request, env, ctx);
  },
};

// ---------------------------------------------------------------------------
// Default handler — serves the authorize page and a simple landing page
// ---------------------------------------------------------------------------

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // OAuth authorize — show consent screen on GET, process approval on POST
    if (url.pathname === "/authorize") {
      const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      if (!oauthReq.clientId) {
        return new Response("Missing client_id", { status: 400 });
      }

      const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
      const clientName = clientInfo?.clientName ?? oauthReq.clientId;

      // POST = user clicked "Allow"
      if (request.method === "POST") {
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReq,
          userId: "demo-user",
          metadata: { label: "demo" },
          scope: oauthReq.scope,
          props: { email: "demo@example.com" } satisfies OAuthProps,
        });
        return Response.redirect(redirectTo, 302);
      }

      // GET = show consent screen
      const scopes = oauthReq.scope?.length ? oauthReq.scope : ["full access"];
      const scopeList = scopes.map((s: string) => `<li>${escapeHtml(s)}</li>`).join("");

      return new Response(
        `<!DOCTYPE html>
<html>
<head>
  <title>Authorize - D1 MCP Demo</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #171717; border: 1px solid #262626; border-radius: 16px; padding: 2rem; width: 100%; max-width: 400px; margin: 1rem; }
    .icon { width: 48px; height: 48px; background: #262626; border-radius: 12px; display: flex; align-items: center; justify-content: center; margin-bottom: 1.5rem; font-size: 24px; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; color: #fafafa; }
    .subtitle { color: #a3a3a3; font-size: 0.875rem; margin-bottom: 1.5rem; line-height: 1.5; }
    .client-name { color: #fafafa; font-weight: 500; }
    .permissions { background: #0a0a0a; border: 1px solid #262626; border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; }
    .permissions-label { font-size: 0.75rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; color: #737373; margin-bottom: 0.75rem; }
    .permissions ul { list-style: none; }
    .permissions li { font-size: 0.875rem; padding: 0.375rem 0; color: #d4d4d4; display: flex; align-items: center; gap: 0.5rem; }
    .permissions li::before { content: ""; width: 6px; height: 6px; background: #525252; border-radius: 50%; flex-shrink: 0; }
    .buttons { display: flex; gap: 0.75rem; }
    button { flex: 1; padding: 0.625rem 1rem; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; transition: background 0.15s; }
    .deny { background: #262626; color: #e5e5e5; }
    .deny:hover { background: #333; }
    .allow { background: #fafafa; color: #0a0a0a; }
    .allow:hover { background: #e5e5e5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔌</div>
    <h1>Authorization Request</h1>
    <p class="subtitle">
      <span class="client-name">${escapeHtml(clientName)}</span> wants to connect to your MCP server.
    </p>
    <div class="permissions">
      <div class="permissions-label">Permissions requested</div>
      <ul>${scopeList}</ul>
    </div>
    <div class="buttons">
      <button class="deny" onclick="window.close()">Deny</button>
      <form method="POST" action="/authorize?${escapeHtml(url.search.slice(1))}">
        <button type="submit" class="allow">Allow</button>
      </form>
    </div>
  </div>
</body>
</html>`,
        { headers: { "content-type": "text/html" } },
      );
    }

    // Landing page
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>D1 MCP Demo</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 4rem auto; padding: 0 1rem;">
  <h1>D1 MCP Demo</h1>
  <p>This is a Cloudflare Worker with:</p>
  <ul>
    <li><strong>D1</strong> database for storage</li>
    <li><strong>MCP server</strong> at <code>/mcp</code></li>
    <li><strong>OAuth 2.1</strong> for MCP authentication</li>
  </ul>
  <p>Connect from Claude Desktop or any MCP client using the MCP endpoint URL.</p>
</body>
</html>`,
        { headers: { "content-type": "text/html" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Export — OAuthProvider wraps everything
// ---------------------------------------------------------------------------

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: [],
});
