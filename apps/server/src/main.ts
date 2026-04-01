import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { Layer } from "effect";

import { addGroup } from "@executor/api";
import { OpenApiGroup } from "@executor/plugin-openapi/api";
import { ToolsHandlers } from "./handlers/tools";
import { SourcesHandlers } from "./handlers/sources";
import { SecretsHandlers } from "./handlers/secrets";
import { OpenApiHandlersLive } from "./handlers/openapi";
import { ExecutorServiceLive } from "./services/executor";

// ---------------------------------------------------------------------------
// Composed API — core + plugin groups
// ---------------------------------------------------------------------------

const ExecutorApiWithPlugins = addGroup(OpenApiGroup);

// ---------------------------------------------------------------------------
// API layer — wire handlers
// ---------------------------------------------------------------------------

const ApiLive = HttpApiBuilder.api(ExecutorApiWithPlugins).pipe(
  Layer.provide([ToolsHandlers, SourcesHandlers, SecretsHandlers, OpenApiHandlersLive]),
  Layer.provide(ExecutorServiceLive),
);

// ---------------------------------------------------------------------------
// Web handler — usable by Vite plugin, standalone server, tests, etc.
// ---------------------------------------------------------------------------

export const createApiHandler = () =>
  HttpApiBuilder.toWebHandler(
    HttpApiSwagger.layer().pipe(
      Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
      Layer.provideMerge(HttpApiBuilder.middlewareCors()),
      Layer.provideMerge(ApiLive),
      Layer.provideMerge(HttpServer.layerContext),
    ),
    { middleware: HttpMiddleware.logger },
  );

export type ApiHandler = ReturnType<typeof createApiHandler>;

export { ExecutorServiceLive } from "./services/executor";
