---
"executor": patch
---

### Highlights

- **Per-user OAuth for OpenAPI and MCP sources.** OpenAPI and MCP sources now carry a first-class **Connection** per user — save OAuth2 sources before signing in, refresh independently, and surface explicit `reauth-required` when refresh can't recover. Legacy OAuth rows are migrated automatically on first launch. The Edit OpenAPI Source page gets a Connections pane; the sidebar shows a live connection badge per source.
- **OpenAPI improvements.** Full OAuth2 client-credentials flow. Non-JSON request bodies encode by content type and honor OAS3 `encoding` + multi-content. Relative OAuth2 URLs resolve against the source `baseUrl`. Refresh a source by re-fetching its origin URL.
- **Layered scope isolation.** Every read and write passes through a layered `ScopeStack`, with the write scope declared explicitly. Plugins adopted the API; the UI exposes it via `CreatableSecretPicker`; WorkOS sources enforce tenant-ownership on every access. Per-scope blob/secret lookups are batched into single `IN` queries.
- **Natural CLI for tool discovery and invocation.** Call tools by path instead of writing TypeScript: `executor call github issues create '{...}'`. New `executor tools {search,sources,describe}` commands and hierarchical `--help` browsing with `--match`/`--limit` for huge namespaces. Errors are normalized for agents.
- **Daemon lifecycle.** `executor daemon {run,status,stop,restart}`. Daemon pointer is now scope-aware and automatically falls back to an open port when the default is busy.
- **OpenTelemetry.** Tool dispatch, plugins, storage, schema, and transport are fully instrumented. Runtime threaded through dispatch so spans actually export in all runtimes.
- **Notion MCP preset** added.

### Breaking changes

- `executor call` no longer accepts inline code. Removed: `executor call '<code>'`, `executor call --file`, `executor call --stdin`. Migrate to explicit tool paths: `executor call <path...> '{"k":"v"}'`. Use `executor tools search "<query>"` instead of `tools.discover(...)`.
- `sources.add` CLI form simplified. Use `executor call openapi addSource '{"spec":"…","namespace":"…","baseUrl":"…"}'`.
- SDK writes now take an explicit scope. Plugins and host code calling the SDK directly must adopt the layered-scope API (in-tree plugins have been migrated as reference).

### Performance

- `buildExecuteDescription` no longer calls `executor.tools.list` — measurably faster tool-description generation on large workspaces.
- Per-scope blob and secret lookups now issue a single `IN` query instead of N per-scope round-trips.

### Fixes

- Keychain: skip provider registration when the OS backend is unreachable (headless Linux without a keyring no longer fails at startup).
- Local server: return 404 for missing static assets instead of serving HTML.
- Tests: Windows compatibility across the suite.
