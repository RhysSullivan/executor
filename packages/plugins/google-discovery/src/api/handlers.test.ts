// ---------------------------------------------------------------------------
// Handler-level integration test for the Google Discovery group.
//
// Verifies the layer wiring stays coherent end-to-end: the handlers
// pull the wrapped extension from the service, and any un-caught cause
// lands in the observability middleware — producing a 500 whose body is
// the opaque `InternalError` schema (no internal leakage).
// ---------------------------------------------------------------------------

import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { addGroup, observabilityMiddleware } from "@executor-js/api";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "@executor-js/api/server";
import type { GoogleDiscoveryPluginExtension } from "../sdk/plugin";
import { GoogleDiscoveryStoredSourceData } from "../sdk/types";
import { GoogleDiscoveryExtensionService, GoogleDiscoveryHandlers } from "./handlers";
import { GoogleDiscoveryGroup } from "./group";

// oxlint-disable-next-line executor/no-error-constructor -- boundary: test injects a defect to verify opaque handler error responses
const unused = Effect.die(new Error("unused"));

const failingExtension: GoogleDiscoveryPluginExtension = {
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: test injects a defect to verify opaque handler error responses
  probeDiscovery: () => Effect.die(new Error("Not implemented")),
  addSource: () => unused,
  removeSource: (_namespace: string, _scope: string) => unused,
  getSource: (_namespace: string, _scope: string) => Effect.succeed(null),
  updateSource: () => unused,
};

const Api = addGroup(GoogleDiscoveryGroup);
const UnusedExecutor = Layer.succeed(ExecutorService)({} as ExecutorService["Service"]);
const UnusedExecutionEngine = Layer.succeed(ExecutionEngineService)(
  {} as ExecutionEngineService["Service"],
);
const HandlerContext = Context.make(ExecutorService, {} as ExecutorService["Service"]).pipe(
  Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
  Context.add(GoogleDiscoveryExtensionService, failingExtension),
);

// `acquireRelease` keeps disposal inside the Effect scope — no
// try/finally, no per-test cleanup plumbing. `it.scoped` closes the
// scope for us.
const WebHandler = Effect.acquireRelease(
  Effect.sync(() =>
    HttpRouter.toWebHandler(
      HttpApiBuilder.layer(Api).pipe(
        Layer.provide(CoreHandlers),
        Layer.provide(GoogleDiscoveryHandlers),
        Layer.provide(observabilityMiddleware(Api)),
        Layer.provide(UnusedExecutor),
        Layer.provide(UnusedExecutionEngine),
        Layer.provide(Layer.succeed(GoogleDiscoveryExtensionService, failingExtension)),
        Layer.provideMerge(HttpServer.layerServices),
        Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
      ),
    ),
  ),
  (web) => Effect.promise(() => web.dispose()),
);

describe("GoogleDiscoveryHandlers", () => {
  it.effect("encodes stored source details returned from the SDK store", () =>
    Effect.gen(function* () {
      const extension: GoogleDiscoveryPluginExtension = {
        ...failingExtension,
        getSource: (namespace, scope) =>
          Effect.succeed({
            namespace,
            scope,
            name: "Calendar",
            config: GoogleDiscoveryStoredSourceData.make({
              name: "Calendar",
              discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
              service: "calendar",
              version: "v3",
              rootUrl: "https://www.googleapis.com/",
              servicePath: "calendar/v3/",
              auth: { kind: "none" },
            }),
          }),
      };
      const context = Context.make(ExecutorService, {} as ExecutorService["Service"]).pipe(
        Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
        Context.add(GoogleDiscoveryExtensionService, extension),
      );
      const web = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(Api).pipe(
              Layer.provide(CoreHandlers),
              Layer.provide(GoogleDiscoveryHandlers),
              Layer.provide(observabilityMiddleware(Api)),
              Layer.provide(UnusedExecutor),
              Layer.provide(UnusedExecutionEngine),
              Layer.provide(Layer.succeed(GoogleDiscoveryExtensionService, extension)),
              Layer.provideMerge(HttpServer.layerServices),
              Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
            ),
          ),
        ),
        (webHandler) => Effect.promise(() => webHandler.dispose()),
      );

      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/scopes/scope_1/google-discovery/sources/calendar"),
          context,
        ),
      );

      expect(response.status).toBe(200);
      const body = yield* Effect.promise(() => response.json());
      expect(body).toMatchObject({
        namespace: "calendar",
        name: "Calendar",
        config: {
          name: "Calendar",
          service: "calendar",
          version: "v3",
        },
      });
    }),
  );

  it.effect("defect-returning methods produce an opaque InternalError, no leakage", () =>
    Effect.gen(function* () {
      const web = yield* WebHandler;
      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/scopes/scope_1/google-discovery/probe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              discoveryUrl: "https://example.googleapis.com/$discovery/rest?version=v1",
            }),
          }),
          HandlerContext,
        ),
      );

      expect(response.status).toBe(500);
      const body = yield* Effect.promise(() => response.text());
      expect(body).not.toContain("Not implemented");
    }),
  );
});
