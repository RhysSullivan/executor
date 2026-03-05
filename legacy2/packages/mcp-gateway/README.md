# mcp-gateway

Bare-minimum MCP gateway for Executor v2.

Current scaffold includes:
- MCP server built with `@modelcontextprotocol/sdk` in `src/server.ts`
- streamable HTTP request handling (`handleMcpHttpRequest`)
- tools: `executor.ping` and `executor.execute` (the execute tool is host-wired via callback)
