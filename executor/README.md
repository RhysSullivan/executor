# Executor Monorepo

Prototype executor control plane for running AI-generated code with tool-call approval gates.

## What Is Here

- `apps/server`: Bun server with:
  - task execution API
  - per-tool-call approval API
  - internal runtime callback API
  - Convex-backed task and approval history
  - pluggable sandbox runtime interface
  - separate worker process for queue execution
- `apps/web`: web interface for:
  - pending approvals
  - task history
  - task details/logs
- `packages/contracts`: shared API/types
- `packages/client`: lightweight client SDK for other consumers (including assistant-side integrations)

## Architecture Notes

- The runtime executes generated code and exposes a `tools.*` proxy to that code.
- The generated-code runtime uses an `ExecutionAdapter` boundary for tool calls and output streaming.
- Current default uses an in-process adapter; an HTTP adapter is also included for process/network boundaries.
- Tools can be marked `auto` or `required` approval.
- Required tools create approval records per function call (`toolPath` + `input`).
- A built-in `tools.discover({ query, depth?, limit? })` helper is available so agents can search available tools at runtime.
- Task execution pauses on required tool calls until that specific call is approved or denied.
- Runtime targets are swappable by ID (`runtimeId`) so sandbox backends can change later.
- Convex is used as the event/history store.

Auth/tenancy design draft: `docs/auth-and-tenancy-model.md`

## Anonymous Web Context (No Sign-In)

The web client now bootstraps an anonymous session context before any task calls:

- `POST /api/auth/anonymous/bootstrap`

Response includes:

- `sessionId`
- `workspaceId`
- `actorId`
- `clientId`

The browser persists `sessionId` and reuses it to maintain the same anonymous workspace/actor context.

Legacy unscoped task/approval reads are disabled. Requests must include workspace context.

## External Tool Sources (MCP + OpenAPI)

You can load callable tools automatically from MCP servers and OpenAPI specs via env config:

`EXECUTOR_TOOL_SOURCES` accepts a JSON array of source definitions.

Example:

```json
[
  {
    "type": "mcp",
    "name": "answeroverflow",
    "url": "https://www.answeroverflow.com/mcp",
    "defaultApproval": "auto"
  },
  {
    "type": "openapi",
    "name": "billing",
    "spec": "https://example.com/openapi.json",
    "baseUrl": "https://api.example.com",
    "defaultReadApproval": "auto",
    "defaultWriteApproval": "required"
  }
]
```

OpenAPI tools are generated as namespaced callables (`tools.<name>.<tag>.<operation>`), and MCP tools are generated as (`tools.<name>.<tool>`).

OpenAPI auth modes in source config:

- `mode: "static"` (token in source config)
- `mode: "workspace"` (shared credential per workspace)
- `mode: "actor"` (bring-your-own credential per actor)

Credential and policy management endpoints:

- `POST /api/policies` and `GET /api/policies?workspaceId=...`
- `POST /api/credentials` and `GET /api/credentials?workspaceId=...`
- `POST /api/tool-sources`, `GET /api/tool-sources?workspaceId=...`, and `DELETE /api/tool-sources/:sourceId?workspaceId=...`

Tasks should include `workspaceId`, `actorId`, and optional `clientId` so policy and credential resolution can be applied per caller.

The web UI supports adding MCP/OpenAPI sources per workspace and viewing discovered workspace tool inventory.

## Vercel Sandbox Runtime

This repo includes a `vercel-sandbox` runtime that runs generated code in Vercel Sandbox VMs while keeping the same `await tools.*(...)` flow.

Local setup:

```bash
vercel project add <project-name>
vercel link --yes --project <project-name>
vercel env pull .env.local --yes
```

Required runtime env:

- `VERCEL_OIDC_TOKEN` (pulled by `vercel env pull`)
- `EXECUTOR_INTERNAL_BASE_URL` (optional override for callback URL; if unset, server can auto-bootstrap a Tailscale Funnel URL in dev)

Optional:

- `EXECUTOR_INTERNAL_TOKEN` (shared bearer token for internal callback routes; auto-generated if unset)
- `EXECUTOR_VERCEL_SANDBOX_RUNTIME` (`node22` by default, supports `node24`)
- `EXECUTOR_AUTO_TAILSCALE_FUNNEL` (`1` by default; set `0` to disable automatic `tailscale funnel --bg` bootstrap)

When creating tasks, set `runtimeId` to `vercel-sandbox` to use this backend.

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
bun run dev
```

Terminal 3:

```bash
bun run dev:worker
```

Server defaults to `http://localhost:4001`. Worker is required unless `EXECUTOR_SERVER_AUTO_EXECUTE=1`.

`dev:convex` runs `convex dev --local`, so persistence stays local (no cloud deployment).
