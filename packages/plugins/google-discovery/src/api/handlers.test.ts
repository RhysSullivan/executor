// ---------------------------------------------------------------------------
// Handler-level integration test for the Google Discovery group.
//
// Verifies the layer wiring stays coherent end-to-end: the handlers
// pull the wrapped extension from the service, and any un-caught cause
// lands in the observability middleware — producing a 500 whose body is
// the opaque `InternalError` schema (no internal leakage).
// ---------------------------------------------------------------------------

import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { addGroup, observabilityMiddleware } from "@executor/api";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "@executor/api/server";
import type { GoogleDiscoveryPluginExtension } from "../sdk/plugin";
import { GoogleDiscoveryExtensionService, GoogleDiscoveryHandlers } from "./handlers";
import { GoogleDiscoveryGroup } from "./group";

const unused = Effect.dieMessage("unused");

const failingExtension: GoogleDiscoveryPluginExtension = {
  probeDiscovery: () => Effect.die(new Error("Not implemented")),
  addSource: () => unused,
  removeSource: (_namespace: string, _scope: string) => unused,
  startOAuth: () => unused,
  completeOAuth: () => Effect.die(new Error("Not implemented")),
  getSource: (_namespace: string, _scope: string) => Effect.succeed(null),
  updateSource: () => unused,
};

const Api = addGroup(GoogleDiscoveryGroup);

// `acquireRelease` keeps disposal inside the Effect scope — no
// try/finally, no per-test cleanup plumbing. `it.scoped` closes the
// scope for us.
const WebHandler = Effect.acquireRelease(
  Effect.sync(() =>
    HttpApiBuilder.toWebHandler(
      HttpApiBuilder.api(Api).pipe(
        Layer.provide(CoreHandlers),
        Layer.provide(GoogleDiscoveryHandlers),
        Layer.provide(observabilityMiddleware(Api)),
        Layer.provide(Layer.succeed(ExecutorService, {} as never)),
        Layer.provide(Layer.succeed(ExecutionEngineService, {} as never)),
        Layer.provide(
          Layer.succeed(GoogleDiscoveryExtensionService, failingExtension),
        ),
        Layer.provideMerge(HttpServer.layerContext),
        Layer.provideMerge(HttpApiBuilder.Router.Live),
        Layer.provideMerge(HttpApiBuilder.Middleware.layer),
      ),
    ),
  ),
  (web) => Effect.promise(() => web.dispose()),
);

describe("GoogleDiscoveryHandlers", () => {
  it.scoped(
    "defect-returning methods produce an opaque InternalError, no leakage",
    () =>
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
          ),
        );

        expect(response.status).toBe(500);
        const body = (yield* Effect.promise(() => response.json())) as {
          _tag?: string;
          traceId?: string;
        };
        expect(body._tag).toBe("InternalError");
        expect(typeof body.traceId).toBe("string");
        expect(JSON.stringify(body)).not.toContain("Not implemented");
      }),
  );
});
