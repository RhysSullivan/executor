# Executor

Executor is a Convex-native execution platform for MCP-driven agents. It provides:

- task execution (`execute`) with tool invocation and approval gates
- workspace-scoped policy, credentials, and tool source management
- MCP endpoints (Convex HTTP routes)
- a Next.js web app for tasks, approvals, tools, members, and billing
- a binary-first install flow for local self-hosted runtime

## Architecture Overview

Core components:

- `packages/convex/`: control plane data model and domain APIs (tasks, approvals, policies, credentials, org/workspace auth, billing).
- `packages/convex/http.ts`: HTTP routes for `/mcp`, `/mcp/anonymous`, OAuth discovery metadata, and internal runtime callbacks.
- `packages/convex/executorNode.ts`: task runner action (`runTask`) and tool invocation plumbing.
- `packages/runner-sandbox-host/`: Cloudflare Worker sandbox runtime host.
- `packages/core/src/`: runtime engine, typechecker, tool discovery, external source adapters (MCP/OpenAPI/GraphQL), credential provider resolvers.
- `apps/web/`: operator UI (dashboard, tasks, approvals, tools, onboarding, org settings).
- `executor.ts`: CLI entrypoint used by local source scripts and compiled binary releases.

Execution flow (high level):

1. Client submits code via MCP `execute`.
2. `createTask` stores a queued task in Convex and schedules `runTask`.
3. `runTask` runs code in the local runtime adapter and resolves tool calls.
4. Tool policies can auto-allow, require approval, or deny.
5. Output, events, approvals, and terminal state are persisted and streamed to clients/UI.

## Running From Source (Inside This Monorepo)

From the monorepo root:

```bash
bun install
cp .env.example .env
```

Set at least:

- `CONVEX_DEPLOYMENT`
- `CONVEX_URL`

Then start executor services (separate terminals):

```bash
# Terminal 1: Convex dev watcher
bun run dev:executor:convex

# Terminal 2: Web UI
bun run dev:executor:web
```

Default source-dev endpoints:

- Web UI: `http://localhost:4312`
- Convex HTTP MCP routes:
  - `<CONVEX_SITE_URL>/mcp` (WorkOS / external OAuth)
  - `<CONVEX_SITE_URL>/mcp/anonymous` (anonymous bearer-token mode)

## Binary Install (No Global Bun/Node/Convex Required)

```bash
curl -fsSL https://executor.sh/install | bash
```

The installed `executor` binary manages its own runtime under `~/.executor/runtime` by default, including:

- managed `convex-local-backend` binary
- managed Node runtime and Convex CLI bootstrap tooling
- packaged web bundle
- local backend config (`instanceName`, `instanceSecret`, ports)
- local SQLite data and file storage

After install, the managed backend and packaged web UI are started automatically in the background.

Common binary commands:

```bash
executor doctor
executor upgrade
executor down
executor up
executor web
executor backend --help
```

Uninstall:

```bash
executor uninstall --yes
```

Default managed-runtime ports:

- backend API: `5410`
- backend site proxy: `5411`
- packaged web app: `5312`

## CLI Commands (executor/package.json)

Run these from `executor/`:

```bash
bun run doctor
bun run doctor:prod
bun run deploy:prod
bun run up
bun run backend -- --help
bun run web
bun run codegen
bun run deploy
bun run build:binary
bun run build:release
```

Notes:

- `build:binary` compiles a host-native `dist/executor` binary.
- `build:release` builds multi-platform binary archives and web archives for all release target names in `dist/release/`.

Manual GitHub release (recommended):

- Run the `Release Executor` workflow from Actions.
- Choose `release_type` (`patch`, `minor`, `major`), or provide `version` explicitly.
- The workflow builds artifacts, creates a new tag (`vX.Y.Z`), and publishes the GitHub release with all required assets.

## MCP and OAuth Surface

Convex HTTP routes (`packages/convex/http.ts`) expose:

- `/mcp` (direct Convex MCP transport for WorkOS / external OAuth)
- `/mcp/anonymous` (direct Convex MCP transport for anonymous bearer tokens)
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/internal/runs/:runId/tool-call`

MCP bearer-token verification is enabled on `/mcp` when `MCP_AUTHORIZATION_SERVER` / `MCP_AUTHORIZATION_SERVER_URL` is configured.
`/mcp/anonymous` uses API-key auth (pass as `Authorization: Bearer <API_KEY>` or `x-api-key`).
Anonymous bearer tokens can still be minted from `/auth/anonymous/token` for Convex anonymous auth flows.

## Configuration Reference

Important env vars (see root `.env.example` for the base template):

- Core:
  - `CONVEX_URL`
  - `CONVEX_SITE_URL`
  - `EXECUTOR_CLOUDFLARE_DYNAMIC_WORKER_ONLY` (`1` in production to force Cloudflare dynamic worker runtime)
- WorkOS (optional auth/org features):
  - `WORKOS_CLIENT_ID`
  - `WORKOS_API_KEY`
  - `WORKOS_WEBHOOK_SECRET`
  - `WORKOS_COOKIE_PASSWORD`
- Billing (optional):
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET`
  - `STRIPE_PRICE_ID`
- MCP auth integration:
  - `MCP_AUTHORIZATION_SERVER` or `MCP_AUTHORIZATION_SERVER_URL`
- Managed runtime:
  - `EXECUTOR_RUNTIME_DIR`
  - `EXECUTOR_BACKEND_PORT`
  - `EXECUTOR_BACKEND_SITE_PORT`
  - `EXECUTOR_WEB_PORT`

## Credential Providers

`sourceCredentials` supports:

- `managed`: stores credential payload in Convex (`secretJson`)
- `workos-vault`: stores encrypted payload in WorkOS Vault and keeps a reference in Convex

`workos-vault` uses `WORKOS_API_KEY` for vault reads. Existing object references can be imported with `secretJson.objectId`.

## Testing and Validation

From `executor/`:

```bash
bun test
bun run sandbox:install:session
```

`sandbox:install:session` starts a fresh Vercel sandbox, runs `curl -fsSL https://executor.sh/install | bash`, and prints externally reachable URLs for:

- Web UI
- Convex API port
- Convex Site (MCP) port (`/mcp`, `/mcp/anonymous`)

Useful environment overrides:

- `EXECUTOR_SANDBOX_TIMEOUT_MS` (default `1800000`)
- `EXECUTOR_SANDBOX_INSTALL_TIMEOUT_MS` (default `900000`)
- `EXECUTOR_BACKEND_PORT`, `EXECUTOR_BACKEND_SITE_PORT`, `EXECUTOR_WEB_PORT`

From repo root:

```bash
bun run test:executor
bun run typecheck:executor
```

## Repository Layout

```text
executor/
|- apps/web/                 # Next.js operator UI
|  `- src/components/{approvals,dashboard,organization,tasks,tools,ui}
|- packages/convex/          # Convex functions, schema, auth, HTTP routes
|  `- runtime/               # task execution/runtime internals
|- packages/runner-sandbox-host/ # Cloudflare worker sandbox runtime
|- packages/core/src/        # shared executor runtime/tooling core package code
|- scripts/dev/              # local/dev-only helpers
|- scripts/prod/             # production setup and deploy scripts
|- scripts/release/          # release artifact builder
|- executor.ts               # CLI entrypoint (compiled into binary)
|- install                   # curl install script
`- uninstall                 # uninstall script
```

## Troubleshooting

- `401` on `/mcp`: verify your bearer token issuer matches `MCP_AUTHORIZATION_SERVER`.
- `401` on `/mcp/anonymous`: pass `API_KEY` from the setup card as `Authorization: Bearer <API_KEY>` (or `x-api-key`).
- Web UI cannot load data: verify `CONVEX_URL` / `CONVEX_SITE_URL` and that Convex dev is running.
- Release build missing web archive files: run `bun run build:release` and verify `executor/dist/release/` contains all expected `executor-web-*.tar.gz` assets.
