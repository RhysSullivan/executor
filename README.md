# Assistant + Executor Monorepo

This repository contains two related projects in one Bun workspace:

- `executor/`: task execution platform (Convex backend, MCP endpoints, approvals, tool discovery, web app, binary CLI installer).
- `assistant/`: assistant-side services and Discord bot integrations that call into executor.

Most active platform work is in `executor/`, but root scripts are set up to run both sides together.

## Monorepo Structure

The root `package.json` wires workspaces for:

- `executor/apps/*`
- `executor/packages/*`
- `assistant`
- `assistant/packages/*`

High-level layout:

```text
.
|- assistant/            # assistant monorepo (core, server, bot, reacord)
|- executor/             # executor platform and binary install tooling
|- dev.ts                # root orchestrator: starts all main dev services
|- kill-all.ts           # cleanup for dev.ts processes
|- .env.example          # canonical env template for the whole repo
`- package.json          # root scripts + workspace graph
```

## Prerequisites

- Bun (required)
- Convex account/project (for source dev against a Convex deployment)
- Optional: Discord bot token, WorkOS and Stripe credentials

## Quick Start

1. Install dependencies from the repository root:

```bash
bun install
```

2. Create local env file:

```bash
cp .env.example .env
```

3. Set required values in `.env`:

- `CONVEX_DEPLOYMENT`
- `CONVEX_URL`

4. Start the full stack:

```bash
bun run dev
```

`bun run dev` starts, in parallel:

- Convex dev watcher for `executor/`
- Executor web app (`http://localhost:4312`)
- Executor MCP endpoint (`<CONVEX_SITE_URL>/mcp`)
- Assistant server (`http://localhost:3002`)
- Discord bot (only if `DISCORD_BOT_TOKEN` is set)

PIDs are tracked in `.dev.pids`. To stop all processes:

```bash
bun run kill:all
```

## Common Root Commands

```bash
# Development
bun run dev
bun run kill:all

# Quality
bun run test
bun run typecheck

# Executor utilities
bun run db:clear:executor
bun run convex:codegen
```

## Environment Model

This repo uses a single root `.env` as the source of truth.

- `assistant` and `executor` scripts read from root env-aware wrappers.
- `executor/apps/web` is a TanStack Start app; canonical vars are consumed by the app and injected at runtime.
- Client-facing values use `VITE_*` names where needed.
- See `.env.example` for optional WorkOS, Stripe, tool-source API keys, and port overrides.

## Project Notes

- The assistant side lives in `assistant/` (server, bot, shared core).
- The execution/control plane lives in `executor/`.
- If you are focused on executor internals, start with `executor/README.md`.

## Testing and Type Safety

From root:

- `bun run test` runs executor and assistant tests.
- `bun run typecheck` runs TypeScript checks for executor and assistant packages.

You can also run package-local checks directly from each subproject.
