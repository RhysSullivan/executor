## Highlights

### Per-user OAuth for OpenAPI and MCP sources
OpenAPI and MCP sources now carry first-class **Connections** — a per-user sign-in state decoupled from the source definition itself.

- Save an OAuth2 OpenAPI or MCP source **before** signing in; users sign in later from the source page.
- Each connection refreshes independently, with concurrent refreshes deduped across the SDK. When a refresh can't recover, the SDK surfaces an explicit `reauth-required` signal instead of silently failing.
- The Edit OpenAPI Source page has a new **Connections** pane showing every user who has signed in and their status. Each source in the sidebar now shows a live connection badge.
- Existing OpenAPI + MCP + google-discovery OAuth rows migrate into Connections automatically on first launch — no user action required.

### OpenAPI: client-credentials, non-JSON bodies, source refresh
- Full **OAuth2 client-credentials** flow end-to-end.
- **Non-JSON request bodies** dispatch correctly by content type; Executor honors OAS3 `encoding` and multi-content operations, and lets the caller pick which content type to send.
- Relative OAuth2 URLs resolve against the source's `baseUrl`.
- Refresh a source by re-fetching its origin URL from the edit page.

### Layered scope isolation
Multi-tenant deployments get a proper security primitive. Every read and write now passes through a layered `ScopeStack`, with the write scope declared explicitly. Plugins have adopted the API; the UI exposes it via `CreatableSecretPicker`; and WorkOS sources enforce tenant-ownership on every access. Per-scope blob and secret lookups are batched into single `IN` queries, so the extra check doesn't cost a round-trip.

### Natural CLI for tool discovery and invocation
Call tools by path instead of writing TypeScript:

```bash
executor call github issues create '{"owner":"octocat","repo":"Hello-World","title":"Hi"}'
executor tools search "send email"
executor tools sources
executor tools describe github.issues.create
```

`executor call <path> --help` browses namespaces → resources → methods, with `--match <text> --limit <n>` to narrow huge namespaces. Errors are normalized for agent consumption, and the resume / help UX is cleaner for non-interactive flows.

### Daemon lifecycle
```bash
executor daemon run
executor daemon status
executor daemon stop
executor daemon restart
```

`executor call`, `executor resume`, and `executor tools …` auto-start a local daemon if one isn't running. The daemon pointer is scope-aware, and if the default port is busy the CLI transparently picks an open one — so two projects can run side-by-side without collisions.

### OpenTelemetry everywhere
Tool dispatch, plugins, storage, schema, and transport are now fully instrumented with OTEL spans, and the runtime is threaded through dispatch so spans actually export in all runtimes.

## New presets
- **Notion** is now a featured MCP preset.

## Performance
- `buildExecuteDescription` no longer calls `executor.tools.list`, making tool-description generation measurably faster on large workspaces.
- Per-scope blob and secret lookups now use a single `IN` query instead of N per-scope round-trips.

## Fixes
- Upgrade: preserve legacy OAuth connection backfills after the `connection.kind` column is removed.
- OpenAPI: refreshing or editing sources with legacy inline secret/OAuth config now materializes the new source binding rows instead of dropping credentials.
- Keychain: skip provider registration when the OS backend is unreachable (no more startup failure when running headless on Linux without a keyring).
- Local server: return 404 for missing static assets instead of serving HTML.
- Tests: Windows compatibility across the suite.

## Breaking changes

### `executor call` no longer accepts inline code
The old TypeScript-as-argument forms are gone:

```bash
executor call '<code>'
executor call --file script.ts
executor call --stdin
```

Migrate to explicit tool paths:

```bash
# before
executor call 'return await tools.github.issues.list({ owner, repo })'
# after
executor call github issues list '{"owner":"octocat","repo":"Hello-World"}'
```

`tools.discover(...)` becomes `executor tools search "<query>"`.

### `sources.add` CLI form simplified
Use the dedicated tool:

```bash
executor call openapi addSource '{
  "spec": "https://petstore3.swagger.io/api/v3/openapi.json",
  "namespace": "petstore",
  "baseUrl": "https://petstore3.swagger.io/api/v3"
}'
```

Pass `baseUrl` when the OpenAPI document has relative `servers` entries.

### SDK: layered scope
Every SDK write now takes an explicit scope. If you have plugins or host code calling the SDK directly, they'll need to adopt the new layered-scope API (see the in-tree plugins for reference — they've all been migrated). This does not affect users of the CLI or web UI.
