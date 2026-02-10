# Executor

Executor is Convex-native and now supports a binary-first install flow.

## Binary install (no global Bun/Node/Convex)

```bash
curl -fsSL https://executor.sh/install | bash
```

The installed `executor` binary bootstraps and manages its own runtime under `~/.executor/runtime`, including:

- `convex-local-backend` (downloaded from Convex precompiled releases)
- packaged Executor web UI bundle
- persisted local backend config (`instanceName`, `instanceSecret`, and ports)
- local SQLite + file storage data

Common commands:

```bash
executor doctor
executor up
executor web
executor backend --help
executor gateway
bash executor/uninstall --yes
```

`executor up` runs the managed `convex-local-backend` binary directly without requiring users to install Bun, Node, or Convex.
On first run, `executor up` also bootstraps Convex functions automatically when a local project checkout is available.
`executor web` runs the packaged web UI on `http://localhost:5312`.

## Local development from source

```bash
bun install
```

Terminal 1:

```bash
bun run dev:convex
```

Terminal 2:

```bash
bun run dev:web
```

Optional Terminal 3 (stateful MCP gateway for elicitation/sampling over Streamable HTTP):

```bash
bun run dev:mcp-gateway
```

## Build distribution artifacts

Build host-native binary:

```bash
bun run build:binary
```

Build release archives for supported platforms:

```bash
bun run build:release
```

Artifacts are written to `dist/release/`.

## Repository layout

- `convex/`: executor control plane, MCP HTTP endpoint, task execution/actions, policies, credentials, approvals, and persistence.
- `lib/`: runtime, MCP server helpers, typechecker, tool loading/discovery utilities.
- `apps/web`: executor web UI for approvals, task history, and settings.
- `apps/menubar`: Electron-based macOS menubar spike for pending task approvals.
- `packages/contracts`: shared task/tool/policy contract types.

## Notes

- MCP endpoint is served by Convex HTTP routes at `/mcp`.
- For a long-lived stateful MCP transport (recommended for elicitation in multi-worker environments), run the gateway at `http://localhost:4313/mcp` in source dev or `http://localhost:5313/mcp` from the installed binary.
- Local gateway auth is optional by default; set `MCP_GATEWAY_REQUIRE_AUTH=1` to enforce MCP OAuth on the gateway.
- Set `MCP_AUTHORIZATION_SERVER` (or `MCP_AUTHORIZATION_SERVER_URL`) to enable MCP OAuth bearer-token verification.
- When MCP OAuth is enabled, the server exposes `/.well-known/oauth-protected-resource` and proxies `/.well-known/oauth-authorization-server`.
- Internal runtime callback routes are served by Convex HTTP routes at `/internal/runs/:runId/*`.
- `run_code` supports TypeScript typechecking and runtime transpilation before execution.
- `run_code` attempts MCP form elicitation for pending tool approvals when the MCP client advertises `elicitation.form`; clients without elicitation support continue using out-of-band approval flow.
- Local source-dev defaults: web `http://localhost:4312`, MCP gateway `http://localhost:4313/mcp`.
- Installed binary default for `executor gateway`: `http://localhost:5313/mcp`.
- WorkOS env vars are optional for local self-hosted usage; WorkOS component wiring is enabled only when all required WorkOS env vars are present.

## Credential providers

`sourceCredentials` supports pluggable providers:

- `managed` (default): stores `secretJson` in Convex.
- `workos-vault`: stores credential payload in encrypted external storage and keeps only a reference in Convex.

`workos-vault` uses `WORKOS_API_KEY` for Vault reads.

Examples for `upsertCredential.secretJson`:

- `managed`: `{ "token": "ghp_..." }`
- `workos-vault`: `{ "token": "ghp_..." }` (backend stores encrypted object)

Compatibility note: `workos-vault` also accepts `{ "objectId": "secret_..." }` when importing existing references.
