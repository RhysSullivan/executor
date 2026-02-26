# app-pm

Local Process Manager app scaffold for Executor v2.

Current scaffold includes:
- local MCP endpoint at `POST /mcp`
- health endpoint at `GET /healthz`
- MCP tool routing via `@executor-v2/mcp-gateway`
- `executor.execute` wired to engine runtime adapters (`local-inproc` default, `deno-subprocess` optional)
- `tools.executor.sources.add/list/remove` available inside execute runtime via in-memory provider wiring
