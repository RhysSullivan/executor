## Fixes

### Source state stays in sync between `executor.jsonc` and the runtime DB

Two regressions kept `executor.jsonc` and the runtime DB from agreeing on which sources exist and how they authenticate. Together they caused deleted sources to come back after a restart and authenticated MCP sources to silently lose their credentials on boot.

- Removing a source from the UI (or via `executor.{openapi,mcp,graphql}.removeSource`) now writes the deletion through to `executor.jsonc`, so the source stays gone after a reboot. Thanks @RyanNg1403 (#408)
- Boot-time replay of remote MCP sources now threads the `auth` block from `executor.jsonc` into `executor.mcp.addSource`, so header-auth and OAuth2 sources connect with credentials on the first request after startup instead of failing the SSE handshake unauthenticated. Thanks @RyanNg1403 (#408)
- Updating an MCP source's auth from the UI (e.g. re-linking an OAuth connection) now writes the change back to `executor.jsonc`, so the new binding survives the next restart instead of being overwritten by stale file state. Thanks @aryasaatvik (#709)

### Variadic tool path arguments no longer crash

Calling a tool with multiple positional path arguments (`executor <tool> path/a path/b ...`) no longer panics in the CLI argument parser. Thanks @grfwings (#761)
