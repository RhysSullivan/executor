import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";

import { addGroup } from "@executor/api";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "@executor/api/server";
import type { GoogleDiscoveryPluginExtension } from "../sdk/plugin";
import { GoogleDiscoveryExtensionService, GoogleDiscoveryHandlers } from "./handlers";
import { GoogleDiscoveryGroup } from "./group";

const unused = Effect.dieMessage("unused");

const createFailingExtension = (): GoogleDiscoveryPluginExtension => ({
  probeDiscovery: () => Effect.die(new Error("Not implemented")),
  addSource: () => unused,
  removeSource: () => unused,
  startOAuth: () => unused,
  completeOAuth: () => Effect.die(new Error("Not implemented")),
  getSource: () => Effect.succeed(null),
});

const Api = addGroup(GoogleDiscoveryGroup);

const fakeExecutor = {} as any;
const fakeExecutionEngine = {} as any;

const createHandler = () =>
  HttpApiBuilder.toWebHandler(
    HttpApiBuilder.api(Api).pipe(
      Layer.provide(CoreHandlers),
      Layer.provide(GoogleDiscoveryHandlers),
      Layer.provide(Layer.succeed(ExecutorService, fakeExecutor)),
      Layer.provide(Layer.succeed(ExecutionEngineService, fakeExecutionEngine)),
      Layer.provide(Layer.succeed(GoogleDiscoveryExtensionService, createFailingExtension())),
      Layer.provideMerge(HttpServer.layerContext),
      Layer.provideMerge(HttpApiBuilder.Router.Live),
      Layer.provideMerge(HttpApiBuilder.Middleware.layer),
    ),
  );

describe("GoogleDiscoveryHandlers", () => {
  it("sanitizes unknown endpoint failures", async () => {
    const web = createHandler();
    try {
      const response = await web.handler(
        new Request("http://localhost/scopes/scope_1/google-discovery/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            discoveryUrl: "https://example.googleapis.com/$discovery/rest?version=v1",
          }),
        }),
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({
        _tag: "GoogleDiscoveryInternalError",
        message: "Internal server error",
      });
      expect(JSON.stringify(body)).not.toContain("Not implemented");
    } finally {
      await web.dispose();
    }
  });
});
