# app-pm

Local Process Manager app scaffold for Executor v2.

Current scaffold includes:
- local MCP endpoint at `GET/POST/DELETE /v1/mcp`
- health endpoint at `GET /healthz`
- MCP tool routing via `@executor-v2/mcp-gateway`
- runtime selection via `PM_RUNTIME_KIND` (`local-inproc`, `deno-subprocess`, `cloudflare-worker-loader`)
- runtime callback endpoint at `POST /v1/runtime/tool-call`
- control-plane source endpoints at `GET/POST /v1/workspaces/:workspaceId/sources`
- control-plane source removal endpoint at `DELETE /v1/workspaces/:workspaceId/sources/:sourceId`
- generated OpenAPI spec endpoint at `GET /v1/openapi.json`

App wiring is now split by responsibility:
- `src/config.ts`: Effect config service (`PORT`)
- `src/mcp-handler.ts`: MCP transport wiring to shared run execution service
- `src/http-server.ts`: Effect HTTP server startup
- `src/main.ts`: Layer composition + process entrypoint
