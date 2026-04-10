import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";

// Export Durable Objects as named exports
export { McpSessionDO } from "./mcp-session";

export default Sentry.withSentry(
  (env: Record<string, string>) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0,
    enableLogs: true,
    sendDefaultPii: true,
  }),
  {
    fetch: handler.fetch,
  },
);
