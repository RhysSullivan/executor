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

- `CONTROL_PLANE_DATABASE_URL`
- `DATABASE_URL`
- `POSTGRES_URL`

If none are set, fallback is local PGlite data at:

- `CONTROL_PLANE_DATA_DIR`
- default: `.executor-v2/web-state/control-plane-pgdata`

If needed, `NEXT_PUBLIC_CONTROL_PLANE_BASE_URL` can override the browser base URL.

MCP install URL generation:

- Derives from existing control-plane/frontend config.
- Prioritizes server-side `CONTROL_PLANE_UPSTREAM_URL` (or server/base control-plane URL) when available.
- In local dev with no DB URL, defaults to local PGlite-backed control-plane in this Next.js app.

WorkOS auth setup (optional but recommended):

- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD` (32+ chars)
- `WORKOS_REDIRECT_URI` or `NEXT_PUBLIC_WORKOS_REDIRECT_URI` (for example `http://localhost:4312/callback`)

When WorkOS is configured, the app requires sign-in and the server proxy forwards the authenticated WorkOS access token to control-plane as a bearer token (`Authorization: Bearer ...`).
