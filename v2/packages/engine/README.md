# engine

Runtime execution engine package for Executor v2.

Current scaffold includes:
- provider contracts (`ToolProvider`) and canonical tool descriptor model
- provider registry service (`ToolProviderRegistryService`) with `discover`/`invoke` routing
- OpenAPI provider invocation and manifest-to-descriptor conversion helpers
- minimal local JavaScript runner with `tools.*` proxy dispatch into provider registry
- vertical integration test covering OpenAPI extraction -> descriptor conversion -> code execution -> HTTP call
