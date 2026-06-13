---
"executor": patch
---

Fix the self-hosted "Connect an agent" MCP URL. The card printed an
organization-scoped path (`<origin>/<organizationId>/mcp`) that the
single-tenant self-host server didn't serve, so connecting an MCP client
authorized successfully but then failed to reach the tools with an HTTP 404.
The self-host server now accepts the organization-scoped path and routes it to
its MCP endpoint.
