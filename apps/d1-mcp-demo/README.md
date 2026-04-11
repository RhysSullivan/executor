# D1 MCP Demo

A minimal Cloudflare Worker that exposes an MCP server with OAuth 2.1 authentication, backed by D1 for storage.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RhysSullivan/executor/tree/d1-mcp-demo/apps/d1-mcp-demo)

## What gets provisioned

Clicking the button above automatically creates:

- **D1 database** — stores app data (notes)
- **KV namespace** — stores OAuth tokens/grants (used by `@cloudflare/workers-oauth-provider`)

No external services, no secrets to configure.

## MCP Tools

| Tool | Description |
|------|-------------|
| `list-notes` | List all notes |
| `add-note` | Add a new note |
| `delete-note` | Delete a note by ID |

## Connect from Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "d1-mcp-demo": {
      "url": "https://<your-worker>.workers.dev/mcp"
    }
  }
}
```

Claude Desktop will handle the OAuth flow automatically — a browser window will open to authorize.

## Local development

```sh
bun install
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```
