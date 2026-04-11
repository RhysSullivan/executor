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

    // OAuth authorize endpoint — simple auto-approve for demo purposes.
    // In production, this would show a consent screen and verify the user's
    // identity via Cloudflare Access JWT or another auth mechanism.
    if (url.pathname === "/authorize") {
      const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      if (!oauthReq.clientId) {
        return new Response("Missing client_id", { status: 400 });
      }

      // Auto-approve — in a real app you'd validate a CF Access JWT here
      // and show a consent screen
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReq,
        userId: "demo-user",
        metadata: { label: "demo" },
        scope: oauthReq.scope,
        props: { email: "demo@example.com" } satisfies OAuthProps,
      });

      return Response.redirect(redirectTo, 302);
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
