import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { BunHttpServer, BunHttpServerRequest } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PmConfig } from "./config";
import { PmMcpHandler } from "./mcp-handler";
import { handleToolCallHttp } from "./tool-call-handler";

const fromWebHandler = (handler: (request: Request) => Promise<Response>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const response = yield* Effect.promise(() =>
      handler(BunHttpServerRequest.toRequest(request))
    );

    return HttpServerResponse.raw(response);
  });

export const startPmHttpServer = Effect.fn("@executor-v2/app-pm/http.start")(function* () {
  const { port } = yield* PmConfig;
  const { handleMcp } = yield* PmMcpHandler;

  const httpLive = HttpRouter.empty.pipe(
    HttpRouter.get("/healthz", HttpServerResponse.json({ ok: true, service: "pm" })),
    HttpRouter.get("/mcp", fromWebHandler(handleMcp)),
    HttpRouter.post("/mcp", fromWebHandler(handleMcp)),
    HttpRouter.del("/mcp", fromWebHandler(handleMcp)),
    HttpRouter.get("/v1/mcp", fromWebHandler(handleMcp)),
    HttpRouter.post("/v1/mcp", fromWebHandler(handleMcp)),
    HttpRouter.del("/v1/mcp", fromWebHandler(handleMcp)),
    HttpRouter.post("/runtime/tool-call", handleToolCallHttp),
    HttpRouter.post("/v1/runtime/tool-call", handleToolCallHttp),
    HttpServer.serve(),
    HttpServer.withLogAddress,
    Layer.provide(BunHttpServer.layer({ port })),
  );

  return yield* Layer.launch(httpLive);
});
