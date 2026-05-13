import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Data, Effect, Layer, Predicate, Scope as EffectScope } from "effect";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

export { makeTestConfig, memorySecretsPlugin } from "./test-config";

export class TestHttpServerAddressError extends Data.TaggedError("TestHttpServerAddressError")<{
  readonly address: unknown;
}> {}

export class TestHttpServerServeError extends Data.TaggedError("TestHttpServerServeError")<{
  readonly cause: unknown;
}> {}

export interface TestHttpServerShape {
  readonly baseUrl: string;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
  readonly url: (path?: string) => string;
}

export type TestHttpRoute = HttpRouter.Route<any, any>;
export type TestHttpRequest = HttpServerRequest.HttpServerRequest;
export type TestHttpResponse = HttpServerResponse.HttpServerResponse;

export const testHttpRoute = HttpRouter.route;

export const serveTestHttpRoutes = (
  routes: readonly TestHttpRoute[],
): Effect.Effect<
  TestHttpServerShape,
  TestHttpServerAddressError | TestHttpServerServeError,
  EffectScope.Scope
> =>
  makeTestHttpServer(
    HttpRouter.serve(HttpRouter.addAll(routes), {
      disableListenLog: true,
      disableLogger: true,
    }),
  );

export const serveTestHttpApp = (
  handler: (request: TestHttpRequest) => Effect.Effect<TestHttpResponse>,
): Effect.Effect<
  TestHttpServerShape,
  TestHttpServerAddressError | TestHttpServerServeError,
  EffectScope.Scope
> =>
  makeTestHttpServer(
    HttpServer.serve(HttpServerRequest.HttpServerRequest.asEffect().pipe(Effect.flatMap(handler))),
  );

const makeTestHttpServer = (
  serverLayer: Layer.Layer<never, never, HttpServer.HttpServer>,
): Effect.Effect<
  TestHttpServerShape,
  TestHttpServerAddressError | TestHttpServerServeError,
  EffectScope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.fresh(serverLayer.pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    ).pipe(Effect.mapError((cause) => new TestHttpServerServeError({ cause })));
    const server = Context.get(context, HttpServer.HttpServer);
    const address = server.address;
    if (!Predicate.isTagged(address, "TcpAddress")) {
      return yield* new TestHttpServerAddressError({ address });
    }
    const client = Context.get(context, HttpClient.HttpClient);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return {
      baseUrl,
      httpClientLayer: Layer.succeed(HttpClient.HttpClient, client),
      url: (path = "") => new URL(path, baseUrl).toString(),
    };
  });
