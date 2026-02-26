# mcp-gateway

Bare-minimum MCP gateway for Executor v2.

Current scaffold includes:
- MCP server built with `@modelcontextprotocol/sdk` in `src/server.ts`
- streamable HTTP request handling (`handleMcpHttpRequest`)
- single top-level tool: `executor.execute`
- runtime/control operations are intended to flow through code execution via `tools.*` (for example `tools.executor.sources.*`)
