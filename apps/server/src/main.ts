import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { Layer } from "effect";

import { addGroup } from "@executor/api";
import { OpenApiGroup } from "@executor/plugin-openapi/api";
import { McpGroup } from "@executor/plugin-mcp/api";
import { OnePasswordGroup } from "@executor/plugin-onepassword/api";
import { ToolsHandlers } from "./handlers/tools";
import { SourcesHandlers } from "./handlers/sources";
import { SecretsHandlers } from "./handlers/secrets";
import { OpenApiHandlersLive } from "./handlers/openapi";
import { McpSourceHandlersLive } from "./handlers/mcp-source";
import { OnePasswordHandlersLive } from "./handlers/onepassword";
import { ExecutorService, ExecutorServiceLayer, getExecutor, type ServerExecutor } from "./services/executor";
import { createMcpRequestHandler, type McpRequestHandler } from "./mcp";

// ---------------------------------------------------------------------------
// Composed API — core + plugin groups
// ---------------------------------------------------------------------------

const ExecutorApiWithPlugins = addGroup(OpenApiGroup).add(McpGroup).add(OnePasswordGroup);

// ---------------------------------------------------------------------------
// API Layer
// ---------------------------------------------------------------------------

const ApiBase = HttpApiBuilder.api(ExecutorApiWithPlugins).pipe(
  Layer.provide([
    ToolsHandlers,
    SourcesHandlers,
    SecretsHandlers,
    OpenApiHandlersLive,
    McpSourceHandlersLive,
    OnePasswordHandlersLive,
  ]),
);

// ---------------------------------------------------------------------------
// Shared server — API + MCP from the same executor instance
// ---------------------------------------------------------------------------

export type ServerHandlers = {
  readonly api: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
  };
  readonly mcp: McpRequestHandler;
};

const createApiHandlerWithExecutor = (executor: ServerExecutor) =>
  HttpApiBuilder.toWebHandler(
    HttpApiSwagger.layer().pipe(
      Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
      Layer.provideMerge(HttpApiBuilder.middlewareCors()),
      Layer.provideMerge(ApiBase),
      Layer.provideMerge(Layer.succeed(ExecutorService, executor)),
      Layer.provideMerge(HttpServer.layerContext),
    ),
    { middleware: HttpMiddleware.logger },
  );

export const createServerHandlersWithExecutor = async (
  executor: ServerExecutor,
): Promise<ServerHandlers> => {
  const api = createApiHandlerWithExecutor(executor);
  const mcp = createMcpRequestHandler({ executor });

  return { api, mcp };
};

export const createServerHandlers = async (): Promise<ServerHandlers> =>
  createServerHandlersWithExecutor(await getExecutor());

// ---------------------------------------------------------------------------
// Backwards compat — standalone API handler (no MCP)
// ---------------------------------------------------------------------------

export const createApiHandler = () =>
  HttpApiBuilder.toWebHandler(
    HttpApiSwagger.layer().pipe(
      Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
      Layer.provideMerge(HttpApiBuilder.middlewareCors()),
      Layer.provideMerge(ApiBase),
      Layer.provideMerge(ExecutorServiceLayer),
      Layer.provideMerge(HttpServer.layerContext),
    ),
    { middleware: HttpMiddleware.logger },
  );

export type ApiHandler = ReturnType<typeof createApiHandler>;

export { ExecutorServiceLayer } from "./services/executor";
