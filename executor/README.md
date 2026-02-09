# Executor Monorepo

Executor is now Convex-native.

## What is here

- `convex/`: executor control plane, MCP HTTP endpoint, task execution/actions, policies, credentials, approvals, and persistence.
- `convex/lib/`: runtime, MCP server helpers, typechecker, tool loading/discovery utilities.
- `apps/web`: executor web UI for approvals, task history, and settings.
- `packages/contracts`: shared task/tool/policy contract types.

## Run

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

## Tests

```bash
bun test convex/database.test.ts convex/executor-mcp.e2e.test.ts
```

## Notes

- MCP endpoint is served by Convex HTTP routes at `/mcp`.
- Set `MCP_AUTHORIZATION_SERVER` (or `MCP_AUTHORIZATION_SERVER_URL`) to enable MCP OAuth bearer-token verification.
- When MCP OAuth is enabled, the server exposes `/.well-known/oauth-protected-resource` and proxies `/.well-known/oauth-authorization-server`.
- Internal runtime callback routes are served by Convex HTTP routes at `/internal/runs/:runId/*`.
- `run_code` supports TypeScript typechecking and runtime transpilation before execution.
- `run_code` now attempts MCP form elicitation for pending tool approvals when the MCP client advertises `elicitation.form`; clients without elicitation support continue using the existing out-of-band approval flow.
