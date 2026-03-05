# app-web

Basic Next.js frontend for Executor v2 control plane.

- Uses `@executor-v2/control-plane` Effect HttpApi client
- Uses Effect Atom (`@effect-atom/atom`, `@effect-atom/atom-react`) for query state

Run:

- `bun run --cwd apps/web dev`
- Open `http://127.0.0.1:3000`

By default, browser control-plane API calls go through the same-origin proxy at
`/api/control-plane`.

The API route now runs the control-plane server in-process.

Database selection priority:

- `DATABASE_URL`

If none are set, fallback is local PGlite data at:

- default: `.executor-v2/web-state/control-plane-pgdata`

MCP install URL generation:

- Derives from existing frontend origin and deployment metadata.
- In local dev with no DB URL, defaults to local PGlite-backed control-plane in this Next.js app.
- MCP endpoint is served from this app at `GET/POST/DELETE /v1/mcp`.

WorkOS auth setup (optional but recommended):

- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD` (32+ chars)
- `WORKOS_REDIRECT_URI` or `NEXT_PUBLIC_WORKOS_REDIRECT_URI` (for example `http://localhost:4312/callback`)

When WorkOS is configured, the app requires sign-in and the server proxy forwards the authenticated WorkOS access token to control-plane as a bearer token (`Authorization: Bearer ...`).

MCP OAuth setup (for external MCP clients):

- `MCP_AUTHORIZATION_SERVER` (or `MCP_AUTHORIZATION_SERVER_URL`, `WORKOS_AUTHKIT_ISSUER`)
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`

Unauthenticated requests to `/v1/mcp` return `401` with `WWW-Authenticate` and `resource_metadata` for OAuth discovery.
