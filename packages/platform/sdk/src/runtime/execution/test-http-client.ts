import {
  HttpApiBuilder,
  HttpApiClient,
  HttpServer,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import {
  ExecutorApi,
  createExecutorApiLayer,
} from "../../../../api/src/index";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  createExecutorEffect,
  type ExecutorRuntime,
} from "../../index";

const createClientLayer = (runtime: ExecutorRuntime) => {
  const apiLayer = Layer.unwrapEffect(
    Effect.map(
      createExecutorEffect({
        backend: {
          createRuntime: () => Effect.succeed(runtime),
        },
      }),
      createExecutorApiLayer,
    ),
  );

  return HttpApiBuilder.serve().pipe(
    Layer.provide(apiLayer),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
};

const createRequestHandler = (runtime: ExecutorRuntime) =>
  Effect.acquireRelease(
    Effect.map(
      createExecutorEffect({
        backend: {
          createRuntime: () => Effect.succeed(runtime),
        },
      }),
      (executor) =>
        HttpApiBuilder.toWebHandler(
          Layer.merge(
            createExecutorApiLayer(executor),
            HttpServer.layerContext,
          ),
        ),
    ),
    (handler) =>
      Effect.tryPromise({
        try: () => handler.dispose(),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error(String(cause ?? "web handler dispose failed")),
      }).pipe(Effect.orDie),
  );

const invokeRequestHandler = (
  handler: ReturnType<typeof HttpApiBuilder.toWebHandler>,
  request: Request,
): Promise<Response> => {
  if (typeof handler === "function") {
    return handler(request);
  }

  const candidate =
    typeof (handler as { handler?: unknown }).handler === "function"
      ? (handler as { handler: (request: Request) => Promise<Response> }).handler
      : typeof (handler as { handle?: unknown }).handle === "function"
        ? (handler as { handle: (request: Request) => Promise<Response> }).handle
        : null;

  if (candidate === null) {
    throw new TypeError("Unsupported executor API request handler");
  }

  return candidate(request);
};

const createExecutorApiClient = () =>
  HttpApiClient.make(ExecutorApi, {
  });

type ExecutorApiClient = Effect.Effect.Success<
  ReturnType<typeof createExecutorApiClient>
>;

export const withExecutorApiClient = <A, E>(
  input: {
    runtime: ExecutorRuntime;
    accountId?: string;
  },
  f: (client: ExecutorApiClient) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const client = yield* createExecutorApiClient();
    return yield* f(client);
  }).pipe(Effect.provide(createClientLayer(input.runtime).pipe(Layer.orDie)));

export const withExecutorApiRequestHandler = <A, E>(
  input: {
    runtime: ExecutorRuntime;
  },
  f: (handleRequest: (request: Request) => Promise<Response>) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const handler = yield* createRequestHandler(input.runtime);
    return yield* f((request) => invokeRequestHandler(handler, request));
  });
