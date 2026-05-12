---
"executor": patch
---

Desktop: ship a new `Settings` page (delivered as the `@executor-js/plugin-desktop-settings` plugin) that lets users pick the sidecar's port, toggle Basic auth on/off, and rotate the auto-generated password. Settings persist via electron-store across launches so the MCP install URL the "Connect an agent" card emits stays valid for AI clients. McpInstallCard's HTTP mode now embeds the desktop's credentials in the URL (e.g. `http://executor:<pw>@127.0.0.1:<port>/mcp`) when running inside the desktop app.
