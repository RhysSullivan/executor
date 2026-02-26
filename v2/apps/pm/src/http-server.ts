import * as Effect from "effect/Effect";

import { PmConfig } from "./config";
import { PmMcpHandler } from "./mcp-handler";
import { PmToolCallHttpHandler } from "./tool-call-handler";

export const startPmHttpServer = Effect.fn("@executor-v2/app-pm/http.start")(function* () {
  const { port } = yield* PmConfig;
  const { handleMcp } = yield* PmMcpHandler;
  const { handleToolCallHttp } = yield* PmToolCallHttpHandler;

  const server = Bun.serve({
    port,
    routes: {
      "/healthz": {
        GET: () => Response.json({ ok: true, service: "pm" }, { status: 200 }),
      },
      "/mcp": {
        GET: handleMcp,
        POST: handleMcp,
        DELETE: handleMcp,
      },
      "/v1/mcp": {
        GET: handleMcp,
        POST: handleMcp,
        DELETE: handleMcp,
      },
      "/runtime/tool-call": {
        POST: handleToolCallHttp,
      },
      "/v1/runtime/tool-call": {
        POST: handleToolCallHttp,
      },
    },
  });

  yield* Effect.logInfo(`executor-v2 PM listening on http://127.0.0.1:${server.port}`);

  return server;
});
