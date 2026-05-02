// ---------------------------------------------------------------------------
// Per-request layer provisioning for `HttpRouter.toWebHandler`
// ---------------------------------------------------------------------------
//
// `HttpRouter.toWebHandler` builds the application layer once into a
// boot-scoped `Context` and reuses it for every request, so any
// `Effect.acquireRelease` inside that layer fires once at worker boot.
// On Cloudflare Workers a postgres.js socket (a `Writable` I/O object)
// opened during request 1 cannot be touched from request 2 — the
// runtime throws "Cannot perform I/O on behalf of a different request".
//
// `Layer.provideMerge` and (despite the name) `HttpRouter.provideRequest`
// both build the inner layer at construction time. The only primitive
// that actually rebuilds per request is a router middleware whose
// per-request handler calls `Layer.build(layer)` inside `Effect.scoped`,
// so `acquireRelease` fires per request and finalizers run when the
// request fiber's scope closes.
//
// See `apps/cloud/src/api.request-scope.node.test.ts` for the regression
// coverage that pins this rule down.
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

/**
 * Build an `HttpRouter.middleware` that provides `layer`'s services to
 * each request. The layer is rebuilt per HTTP request so
 * `Effect.acquireRelease` fires per request and is released when the
 * request fiber's scope closes.
 *
 * The returned value is a `Middleware`. Use `.layer` to apply it as a
 * standalone layer; use `.combine(other)` to fold it into another
 * middleware whose per-request body needs services this layer provides
 * (e.g. `ExecutionStackMiddleware`'s auth logic that yields
 * `DbService` + `UserStoreService` — combining drops those from the
 * outer middleware's `requires`).
 */
export const requestScopedMiddleware = <A>(layer: Layer.Layer<A>) =>
  HttpRouter.middleware<{ provides: A }>()((httpEffect) =>
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(layer);
        return yield* Effect.provideContext(httpEffect, services);
      }),
    ),
  );
