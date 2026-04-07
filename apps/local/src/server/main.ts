import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { Layer } from "effect";

import { addGroup, CoreHandlers, ExecutorService, ExecutionEngineService } from "@executor/api";
import { createExecutionEngine } from "@executor/execution";
import { OpenApiGroup, OpenApiHandlers, OpenApiExtensionService } from "@executor/plugin-openapi/api";
import { McpGroup, McpHandlers, McpExtensionService } from "@executor/plugin-mcp/api";
import { GoogleDiscoveryGroup, GoogleDiscoveryHandlers, GoogleDiscoveryExtensionService } from "@executor/plugin-google-discovery/api";
import { OnePasswordGroup, OnePasswordHandlers, OnePasswordExtensionService } from "@executor/plugin-onepassword/api";
import { GraphqlGroup, GraphqlHandlers, GraphqlExtensionService } from "@executor/plugin-graphql/api";
import { getExecutor } from "./executor";
import { createMcpRequestHandler, type McpRequestHandler } from "./mcp";

// ---------------------------------------------------------------------------
// Local server API — core + all plugin groups
// ---------------------------------------------------------------------------

const LocalApi = addGroup(OpenApiGroup)
  .add(McpGroup)
  .add(GoogleDiscoveryGroup)
  .add(OnePasswordGroup)
  .add(GraphqlGroup);

const LocalApiBase = HttpApiBuilder.api(LocalApi).pipe(
  Layer.provide(CoreHandlers),
  Layer.provide(Layer.mergeAll(
    OpenApiHandlers,
    McpHandlers,
    GoogleDiscoveryHandlers,
    OnePasswordHandlers,
    GraphqlHandlers,
  )),
);

// ---------------------------------------------------------------------------
// Server handlers
// ---------------------------------------------------------------------------

export type ServerHandlers = {
  readonly api: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
  };
  readonly mcp: McpRequestHandler;
};

export const createServerHandlers = async (): Promise<ServerHandlers> => {
  const executor = await getExecutor();
  const engine = createExecutionEngine({ executor });

  const pluginExtensions = Layer.mergeAll(
    Layer.succeed(OpenApiExtensionService, executor.openapi),
    Layer.succeed(McpExtensionService, executor.mcp),
    Layer.succeed(GoogleDiscoveryExtensionService, executor.googleDiscovery),
    Layer.succeed(OnePasswordExtensionService, executor.onepassword),
    Layer.succeed(GraphqlExtensionService, executor.graphql),
  );

  const api = HttpApiBuilder.toWebHandler(
    HttpApiSwagger.layer().pipe(
      Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
      Layer.provideMerge(LocalApiBase),
      Layer.provideMerge(pluginExtensions),
      Layer.provideMerge(Layer.succeed(ExecutorService, executor)),
      Layer.provideMerge(Layer.succeed(ExecutionEngineService, engine)),
      Layer.provideMerge(HttpServer.layerContext),
    ),
    { middleware: HttpMiddleware.logger },
  );

  const mcp = createMcpRequestHandler({ engine });

  return { api, mcp };
};
