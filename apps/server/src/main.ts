import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { Effect, Layer } from "effect";

import { addGroup } from "@executor/api";
import { createExecutionEngine } from "@executor/execution";
import { OpenApiGroup } from "@executor/plugin-openapi/api";
import { McpGroup } from "@executor/plugin-mcp/api";
import { GoogleDiscoveryGroup } from "@executor/plugin-google-discovery/api";
import { OnePasswordGroup } from "@executor/plugin-onepassword/api";
import { GraphqlGroup } from "@executor/plugin-graphql/api";
import { ToolsHandlers } from "./handlers/tools";
import { SourcesHandlers } from "./handlers/sources";
import { SecretsHandlers } from "./handlers/secrets";
import { ExecutionsHandlers } from "./handlers/executions";
import { OpenApiHandlersLive } from "./handlers/openapi";
import { McpSourceHandlersLive } from "./handlers/mcp-source";
import { GoogleDiscoveryHandlersLive } from "./handlers/google-discovery";
import { OnePasswordHandlersLive } from "./handlers/onepassword";
import { GraphqlHandlersLive } from "./handlers/graphql";
import { ExecutorService, ExecutorServiceLayer, getExecutor, type ServerExecutor } from "./services/executor";
import { ExecutionEngineService } from "./services/engine";
import { createMcpRequestHandler, type McpRequestHandler } from "./mcp";

// ---------------------------------------------------------------------------
// Composed API — core + plugin groups
// ---------------------------------------------------------------------------

const ExecutorApiWithPlugins = addGroup(OpenApiGroup)
  .add(McpGroup)
  .add(GoogleDiscoveryGroup)
  .add(OnePasswordGroup)
  .add(GraphqlGroup);

// ---------------------------------------------------------------------------
// API Layer
// ---------------------------------------------------------------------------

const ApiBase = HttpApiBuilder.api(ExecutorApiWithPlugins).pipe(
  Layer.provide([
    ToolsHandlers,
    SourcesHandlers,
    SecretsHandlers,
    ExecutionsHandlers,
    OpenApiHandlersLive,
    McpSourceHandlersLive,
    GoogleDiscoveryHandlersLive,
    OnePasswordHandlersLive,
    GraphqlHandlersLive,
  ]),
);

// ---------------------------------------------------------------------------
// Composable API layer — for use with Effect platform HTTP servers
// ---------------------------------------------------------------------------

export const ApiLayer = HttpApiSwagger.layer().pipe(
  Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
  Layer.provideMerge(ApiBase),
);

// ---------------------------------------------------------------------------
// Shared server — API + MCP from the same executor + engine instance
// ---------------------------------------------------------------------------

export type ServerHandlers = {
  readonly api: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
  };
  readonly mcp: McpRequestHandler;
};

const createApiHandlerWithExecutor = (executor: ServerExecutor, engine: ReturnType<typeof createExecutionEngine>) =>
  HttpApiBuilder.toWebHandler(
    HttpApiSwagger.layer().pipe(
      Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
      Layer.provideMerge(ApiBase),
      Layer.provideMerge(Layer.succeed(ExecutorService, executor)),
      Layer.provideMerge(Layer.succeed(ExecutionEngineService, engine)),
      Layer.provideMerge(HttpServer.layerContext),
    ),
    { middleware: HttpMiddleware.logger },
  );

export const createServerHandlersWithExecutor = async (
  executor: ServerExecutor,
): Promise<ServerHandlers> => {
  const engine = createExecutionEngine({ executor });
  const api = createApiHandlerWithExecutor(executor, engine);
  const mcp = createMcpRequestHandler({ engine });

  return { api, mcp };
};

export const createServerHandlers = async (): Promise<ServerHandlers> =>
  createServerHandlersWithExecutor(await getExecutor());

// ---------------------------------------------------------------------------
// Backwards compat — standalone API handler (no MCP)
// ---------------------------------------------------------------------------

const ExecutionEngineLayer = Layer.effect(
  ExecutionEngineService,
  Effect.map(ExecutorService, (executor) => createExecutionEngine({ executor })),
);

export const createApiHandler = () =>
  HttpApiBuilder.toWebHandler(
    HttpApiSwagger.layer().pipe(
      Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
      Layer.provideMerge(ApiBase),
      Layer.provideMerge(ExecutionEngineLayer),
      Layer.provideMerge(ExecutorServiceLayer),
      Layer.provideMerge(HttpServer.layerContext),
    ),
    { middleware: HttpMiddleware.logger },
  );

export type ApiHandler = ReturnType<typeof createApiHandler>;

export { ExecutorServiceLayer } from "./services/executor";
