## Highlights

### Executor Desktop (mac, windows, linux)

The CLI's web UI now ships as a native desktop app. Same gateway, same UI, same sources — packaged with the Bun-compiled server bundled inside the Electron app so there's no Node install, no `executor web` running in your terminal, no port to remember.

- Drag-to-Applications DMG with the Executor icon. Auto-updates via `electron-updater` directly from GitHub releases.
- macOS builds are signed with a Developer ID Application cert and notarized through the App Store Connect API — first launch is a single click, no Gatekeeper dance.
- State lives at `~/.executor/` — the same path the CLI uses. Sources, secrets, and policies set up in `executor web` show up in the desktop app and vice versa.
- Linux: AppImage / deb / rpm for x64 and arm64. Windows: `.exe` (currently unsigned — code-signing pipeline in flight).

Downloads land on each [GitHub release](https://github.com/RhysSullivan/executor/releases/latest) under the `executor-desktop-*` assets.

## UI

- Sidebar now shows a "Beta" pill next to the executor wordmark.
