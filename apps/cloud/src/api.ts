// ---------------------------------------------------------------------------
// Cloud API — core handlers from @executor/api + cloud-specific plugins
// ---------------------------------------------------------------------------

import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { Effect, Layer } from "effect";

import { addGroup, CoreHandlers, ExecutorService, ExecutionEngineService } from "@executor/api";
import { createExecutionEngine } from "@executor/execution";
import { makeUserStore } from "@executor/storage-postgres";
import { OpenApiGroup, OpenApiExtensionService, OpenApiHandlers } from "@executor/plugin-openapi/api";
import { McpGroup, McpExtensionService, McpHandlers } from "@executor/plugin-mcp/api";
import { GoogleDiscoveryGroup, GoogleDiscoveryExtensionService, GoogleDiscoveryHandlers } from "@executor/plugin-google-discovery/api";
import { GraphqlGroup, GraphqlExtensionService, GraphqlHandlers } from "@executor/plugin-graphql/api";

import { createTeamExecutor } from "./services/executor";
import { authenticateRequest } from "./auth/workos";
import type { DrizzleDb } from "./services/db";

// ---------------------------------------------------------------------------
// Cloud API — core + cloud plugins (no onepassword)
// ---------------------------------------------------------------------------

const CloudApi = addGroup(OpenApiGroup)
  .add(McpGroup)
  .add(GoogleDiscoveryGroup)
  .add(GraphqlGroup);

const CloudApiBase = HttpApiBuilder.api(CloudApi).pipe(
  Layer.provide(CoreHandlers),
  Layer.provide(Layer.mergeAll(
    OpenApiHandlers,
    McpHandlers,
    GoogleDiscoveryHandlers,
    GraphqlHandlers,
  )),
);

// ---------------------------------------------------------------------------
// Cookie parser
// ---------------------------------------------------------------------------

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.slice(name.length + 1) || null;
};

// ---------------------------------------------------------------------------
// Create API handler with auth-based executor resolution
// ---------------------------------------------------------------------------

export const createCloudApiHandler = (db: DrizzleDb, encryptionKey: string) => {
  const userStore = makeUserStore(db);

  return async (request: Request): Promise<Response> => {
    const auth = await authenticateRequest(request);
    if (!auth) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const teamId = parseCookie(request.headers.get("cookie"), "executor_team");
    if (!teamId) {
      return Response.json({ error: "No team selected" }, { status: 401 });
    }

    const team = await userStore.getTeam(teamId);
    const teamName = team?.name ?? "Unknown Team";

    const executor = await Effect.runPromise(
      createTeamExecutor(db, teamId, teamName, encryptionKey),
    );

    const pluginExtensions = Layer.mergeAll(
      Layer.succeed(OpenApiExtensionService, executor.openapi),
      Layer.succeed(McpExtensionService, executor.mcp),
      Layer.succeed(GoogleDiscoveryExtensionService, executor.googleDiscovery),
      Layer.succeed(GraphqlExtensionService, executor.graphql),
    );

    const engine = createExecutionEngine({ executor });

    const handler = HttpApiBuilder.toWebHandler(
      HttpApiSwagger.layer().pipe(
        Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
        Layer.provideMerge(CloudApiBase),
        Layer.provideMerge(pluginExtensions),
        Layer.provideMerge(Layer.succeed(ExecutorService, executor)),
        Layer.provideMerge(Layer.succeed(ExecutionEngineService, engine)),
        Layer.provideMerge(HttpServer.layerContext),
      ),
      { middleware: HttpMiddleware.logger },
    );

    try {
      return await handler.handler(request);
    } finally {
      await Effect.runPromise(executor.close()).catch(() => undefined);
      handler.dispose();
    }
  };
};
