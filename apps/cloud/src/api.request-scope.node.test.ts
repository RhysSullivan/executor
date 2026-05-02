// ---------------------------------------------------------------------------
// Regression for https://github.com/RhysSullivan/executor/pull/468 — the
// cloud API v4 routing refactor wired DbService.Live (and other I/O-holding
// services) into `Layer.provideMerge` of an `HttpRouter.toWebHandler` app.
// `toWebHandler` builds the layer ONCE at worker boot and reuses the
// resolved Context for every request, so `Effect.acquireRelease` runs only
// at boot. On Cloudflare Workers that means the postgres.js socket (a
// `Writable` I/O object) is opened in request 1's context and reused by
// request 2, which the runtime forbids:
//
//   StorageError: [storage-drizzle] findMany select failed:
//     Cannot perform I/O on behalf of a different request. (I/O type: Writable)
//
// The only primitive that actually rebuilds per request is a custom
// `HttpRouter.middleware` whose per-request handler does
// `Layer.build(layer)` inside `Effect.scoped`. `provideMerge` runs the
// layer at boot; `HttpRouter.provideRequest` (despite its name) also runs
// the layer at boot — its `Layer.build` lives in the *outer* middleware
// effect, which executes at layer-construction time. Only an explicit
// `Effect.scoped` inside the per-request handler creates a fresh scope
// for `acquireRelease`.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

import { RequestScopedServicesLive } from "./api/layers";
import { requestScopedMiddleware } from "./api/request-scoped";
import { makeApiLive } from "./api/router";

class Counter extends Context.Service<
  Counter,
  { readonly id: number }
>()("test/Counter") {}

const makeCounterLive = (counts: { acquires: number; releases: number }) =>
  Layer.effect(Counter)(
    Effect.acquireRelease(
      Effect.sync(() => {
        counts.acquires += 1;
        return { id: counts.acquires };
      }),
      () =>
        Effect.sync(() => {
          counts.releases += 1;
        }),
    ),
  );

const Routes = HttpRouter.add(
  "GET",
  "/",
  Effect.gen(function* () {
    const c = yield* Counter;
    return HttpServerResponse.jsonUnsafe({ id: c.id });
  }),
);

describe("HttpRouter.toWebHandler request scoping", () => {
  it("Layer.provideMerge of a scoped layer captures the boot scope (the bug)", async () => {
    const counts = { acquires: 0, releases: 0 };
    const App = Routes.pipe(
      Layer.provideMerge(makeCounterLive(counts)),
      Layer.provideMerge(HttpServer.layerServices),
    );
    const handler = HttpRouter.toWebHandler(App, { disableLogger: true })
      .handler;

    const a = await handler(new Request("http://test.local/"));
    const b = await handler(new Request("http://test.local/"));

    // Same id => the resource was acquired once at boot and shared.
    // On Cloudflare Workers this is the I/O-isolation crash mode.
    expect(await a.json()).toEqual({ id: 1 });
    expect(await b.json()).toEqual({ id: 1 });
    expect(counts.acquires).toBe(1);
  });

  it("HttpRouter.provideRequest is misleadingly named — it also captures boot scope", async () => {
    const counts = { acquires: 0, releases: 0 };
    const App = Routes.pipe(
      HttpRouter.provideRequest(makeCounterLive(counts)),
      Layer.provideMerge(HttpServer.layerServices),
    );
    const handler = HttpRouter.toWebHandler(App, { disableLogger: true })
      .handler;

    const a = await handler(new Request("http://test.local/"));
    const b = await handler(new Request("http://test.local/"));

    // `provideRequest` runs `Layer.build` in the OUTER middleware effect,
    // which fires at layer-construction time — same lifetime as the boot
    // scope. Both requests see the same acquired resource.
    expect(await a.json()).toEqual({ id: 1 });
    expect(await b.json()).toEqual({ id: 1 });
    expect(counts.acquires).toBe(1);
  });

  it("requestScopedMiddleware runs acquireRelease per request (the fix)", async () => {
    const counts = { acquires: 0, releases: 0 };
    const App = Routes.pipe(
      Layer.provide(requestScopedMiddleware(makeCounterLive(counts)).layer),
      Layer.provideMerge(HttpServer.layerServices),
    );
    const handler = HttpRouter.toWebHandler(App, { disableLogger: true })
      .handler;

    const a = await handler(new Request("http://test.local/"));
    const b = await handler(new Request("http://test.local/"));

    expect(await a.json()).toEqual({ id: 1 });
    expect(await b.json()).toEqual({ id: 2 });
    expect(counts.acquires).toBe(2);
    expect(counts.releases).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Regression test against the prod handler factory. If anyone reverts
// `makeApiLive` back to wiring `RequestScopedServicesLive` via
// `Layer.provideMerge`, this test fails — the counter only increments
// once at boot instead of once per request.
// ---------------------------------------------------------------------------

describe("makeApiLive (prod handler factory) request scoping", () => {
  it("rebuilds RequestScopedServicesLive per request", async () => {
    const counts = { acquires: 0, releases: 0 };
    // Wrap the real per-request layer with an `acquireRelease` counter.
    // `requestScopedMiddleware` calls `Layer.build` per request, so this
    // counter increments per request iff the wiring is correct.
    const trackedRsLive = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          counts.acquires += 1;
        }),
        () =>
          Effect.sync(() => {
            counts.releases += 1;
          }),
      ),
    ).pipe(Layer.provideMerge(RequestScopedServicesLive));

    const handler = HttpRouter.toWebHandler(makeApiLive(trackedRsLive), {
      disableLogger: true,
    }).handler;

    // Hit a protected route. ExecutionStackMiddleware short-circuits with
    // 403 (no session cookie) but not before `requestScopedMiddleware`
    // has built the per-request layer. We don't care about the response —
    // only that the layer was built once per request.
    await handler(new Request("http://test.local/scope"));
    await handler(new Request("http://test.local/scope"));

    expect(counts.acquires).toBe(2);
    expect(counts.releases).toBe(2);
  });
});
