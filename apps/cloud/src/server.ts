import handler from "@tanstack/react-start/server-entry";

// Export Durable Objects as named exports
export { McpSessionDO } from "./mcp-session";

export default {
  fetch: handler.fetch,
};
