# app-pm

Local Process Manager app scaffold for Executor v2.

Current scaffold includes:
- local MCP endpoint at `POST /mcp`
- health endpoint at `GET /healthz`
- MCP tool routing via `@executor-v2/mcp-gateway`
- local runtime adapter injection (`makeLocalInProcessRuntimeAdapter()` in entry wiring)
 runtime callback endpoint at `POST /runtime/tool-call`

App wiring is now split by responsibility:
- `src/config.ts`: Effect config service (`PORT`)
- `src/run-executor.ts`: run execution service for an injected runtime adapter
- `src/mcp-handler.ts`: MCP transport wiring to run client
- `src/http-server.ts`: Effect HTTP server startup
- `src/main.ts`: Layer composition + process entrypoint
