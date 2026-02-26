# engine

Runtime execution engine package for Executor v2.

Current scaffold includes:
- provider contracts (`ToolProvider`) and canonical tool descriptor model
- provider registry service (`ToolProviderRegistryService`) with `discover`/`invoke` routing
- OpenAPI provider invocation and manifest-to-descriptor conversion helpers
- source-config-aware OpenAPI auth header injection (`api_key` / `bearer`)
- minimal in-process JavaScript runner with `tools.*` proxy dispatch into provider registry
- Deno subprocess runner with line-delimited JSON IPC for proxied `tools.*` calls
- runtime adapter contract + registry (`local-inproc`, `deno-subprocess`, `cloudflare-worker-loader` scaffold)
- vertical integration test covering OpenAPI extraction -> descriptor conversion -> code execution -> HTTP call
