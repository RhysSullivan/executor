import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";

import { addGroup } from "@executor/api";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "@executor/api/server";
import type { McpPluginExtension } from "../sdk/plugin";
import { McpExtensionService, McpHandlers } from "./handlers";
import { McpGroup } from "./group";

const unused = Effect.dieMessage("unused");

const createFailingExtension = (): McpPluginExtension => ({
  probeEndpoint: () => Effect.die(new Error("Not implemented")),
  addSource: () => unused,
  removeSource: () => unused,
  refreshSource: () => unused,
  startOAuth: () => unused,
  completeOAuth: () => Effect.die(new Error("Not implemented")),
  getSource: () => Effect.succeed(null),
  updateSource: () => unused,
});

const Api = addGroup(McpGroup);

const fakeExecutor = {} as any;
const fakeExecutionEngine = {} as any;

const createHandler = () =>
  HttpApiBuilder.toWebHandler(
    HttpApiBuilder.api(Api).pipe(
      Layer.provide(CoreHandlers),
      Layer.provide(McpHandlers),
      Layer.provide(Layer.succeed(ExecutorService, fakeExecutor)),
      Layer.provide(Layer.succeed(ExecutionEngineService, fakeExecutionEngine)),
      Layer.provide(Layer.succeed(McpExtensionService, createFailingExtension())),
      Layer.provideMerge(HttpServer.layerContext),
      Layer.provideMerge(HttpApiBuilder.Router.Live),
      Layer.provideMerge(HttpApiBuilder.Middleware.layer),
    ),
  );

describe("McpHandlers", () => {
  it("sanitizes unknown endpoint failures", async () => {
    const web = createHandler();
    try {
      const response = await web.handler(
        new Request("http://localhost/scopes/scope_1/mcp/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: "https://example.com/mcp" }),
        }),
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({
        _tag: "McpInternalError",
        message: "Internal server error",
      });
      expect(JSON.stringify(body)).not.toContain("Not implemented");
    } finally {
      await web.dispose();
    }
  });
});
