# Executor macOS Menubar (Spike)

This app is an initial Electron-based menubar/tray client for reviewing and resolving pending Executor approvals.

It polls `workspace.listPendingApprovals`, displays pending approvals in a tray menu, and calls `executor.resolveApproval` for Approve/Deny actions.

## Why this shape

- Uses existing Convex APIs, so no backend changes were required.
- Works with anonymous local sessions (`workspace.bootstrapAnonymousSession`) and bearer-token auth.
- Keeps the first iteration small so we can validate approval workflow ergonomics before investing in native packaging.

## Configuration

Set these environment variables before launching:

- `CONVEX_URL` (required): Convex deployment URL.
- `EXECUTOR_WORKSPACE_ID` (optional): workspace to monitor. If omitted, the app resolves a workspace automatically.
- `EXECUTOR_SESSION_ID` (optional): session for anonymous/local usage.
- `EXECUTOR_AUTH_TOKEN` (optional): bearer token for WorkOS-authenticated usage.
- `EXECUTOR_POLL_INTERVAL_MS` (optional): polling interval, minimum `1000`, default `5000`.

If `EXECUTOR_AUTH_TOKEN` is not set, the app bootstraps an anonymous session automatically.

## Run

```bash
bun run --cwd executor/apps/menubar dev
```

## Current limitations

- Poll-based updates (no subscription stream yet).
- No sign-in UI yet; auth/session values are passed through env vars.
- No app signing/notarization/package pipeline yet for distribution.

## Next production steps

1. Replace polling with Convex live subscriptions or an event stream.
2. Add in-app auth flow (WorkOS OAuth/device flow) and secure local token storage.
3. Add macOS packaging (`.app`), code signing, and notarization automation.
4. Add richer approval detail view (input payload and tool metadata) in a popover window.
