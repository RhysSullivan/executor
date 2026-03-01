# app-web

Basic Next.js frontend for Executor v2 control plane.

- Uses `@executor-v2/control-plane` Effect HttpApi client
- Uses Effect Atom (`@effect-atom/atom`, `@effect-atom/atom-react`) for query state

Run:

- `bun run --cwd apps/web dev`
- Open `http://127.0.0.1:3000`

By default, control-plane API calls go directly to `http://127.0.0.1:8788`.
Override with `NEXT_PUBLIC_CONTROL_PLANE_BASE_URL` (and optionally `CONTROL_PLANE_SERVER_BASE_URL` for SSR).

MCP install URL generation:

- Derives from existing control-plane/frontend config.
- Prioritizes server-side `CONTROL_PLANE_UPSTREAM_URL` (or server/base control-plane URL) when available.
- In local dev, defaults to direct Convex MCP URL: `http://127.0.0.1:8788/v1/mcp?...`

WorkOS auth setup (optional but recommended):

- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD` (32+ chars)
- `WORKOS_REDIRECT_URI` or `NEXT_PUBLIC_WORKOS_REDIRECT_URI` (for example `http://localhost:4312/callback`)

When WorkOS is configured, the app requires sign-in and forwards the authenticated WorkOS user id to control-plane as `x-executor-account-id`.
For local non-WorkOS testing, you can still set `NEXT_PUBLIC_CONTROL_PLANE_ACCOUNT_ID` to send a static account id.
