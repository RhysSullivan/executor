# Prototype Monorepo

This repository is now split into two nested monorepos:

- `assistant/`: assistant-side code and integrations.
- `executor/`: executor infrastructure (sandbox runtime, approvals API, task history, web UI).

## Focus Area

The active prototype work is in `executor/`.

## Quick Start

```bash
bun install --cwd executor
```

Terminal 1:

```bash
bun run --cwd executor dev:convex
```

Terminal 2:

```bash
bun run --cwd executor dev
```

Terminal 3:

```bash
bun run --cwd executor dev:worker
```

Terminal 4:

```bash
bun run --cwd executor dev:web
```

This starts:

- Local Convex backend
- Executor API server (control plane + internal runtime callbacks)
- Executor worker (queued task execution)
- Executor web UI (pending approvals + task history)
