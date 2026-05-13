import {
  Context,
  Data,
  Effect,
  Layer,
  Predicate,
  Ref,
  Schema as EffectSchema,
  Scope,
} from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString } from "graphql";
import { createYoga, type GraphQLParams, type YogaInitialContext } from "graphql-yoga";
import { serveTestHttpApp } from "@executor-js/sdk/testing";

const GraphqlRequestPayload = EffectSchema.Struct({
  query: EffectSchema.optional(EffectSchema.String),
  variables: EffectSchema.optional(EffectSchema.Record(EffectSchema.String, EffectSchema.Unknown)),
  operationName: EffectSchema.optional(EffectSchema.NullOr(EffectSchema.String)),
});

type GraphqlRequestPayload = typeof GraphqlRequestPayload.Type;

export interface GraphqlTestRequest {
  readonly url: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: GraphqlRequestPayload;
}

export interface GraphqlTestContext {
  readonly request: GraphqlTestRequest;
}

export interface GraphqlTestServerOptions {
  readonly schema: GraphQLSchema;
  readonly path?: string;
}

export interface GraphqlTestServerShape {
  readonly endpoint: string;
  readonly schema: GraphQLSchema;
  readonly requests: Effect.Effect<readonly GraphqlTestRequest[]>;
  readonly clearRequests: Effect.Effect<void>;
}

class GraphqlTestServerAddressError extends Data.TaggedError("GraphqlTestServerAddressError")<{
  readonly address: unknown;
}> {}

class GraphqlTestServerHandlerError extends Data.TaggedError("GraphqlTestServerHandlerError")<{
  readonly cause: unknown;
}> {}

const headersFromRequest = (headers: Headers): Readonly<Record<string, string>> =>
  Object.fromEntries(headers.entries());

const payloadFromParams = (params: GraphQLParams): GraphqlRequestPayload => ({
  query: params.query,
  variables:
    typeof params.variables === "object" && params.variables !== null
      ? params.variables
      : undefined,
  operationName: params.operationName ?? null,
});

const captureRequest = (
  initial: YogaInitialContext,
  requests: Ref.Ref<readonly GraphqlTestRequest[]>,
) => {
  const url = new URL(initial.request.url);
  const captured: GraphqlTestRequest = {
    url: initial.request.url,
    method: initial.request.method,
    path: url.pathname,
    headers: headersFromRequest(initial.request.headers),
    payload: payloadFromParams(initial.params),
  };
  return Effect.runPromise(
    Ref.update(requests, (all) => [...all, captured]).pipe(Effect.as(captured)),
  );
};

export const serveGraphqlTestServer = (
  options: GraphqlTestServerOptions,
): Effect.Effect<
  GraphqlTestServerShape,
  GraphqlTestServerAddressError | GraphqlTestServerHandlerError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<readonly GraphqlTestRequest[]>([]);
    const path = options.path ?? "/graphql";

    const yoga = createYoga<Record<string, never>, GraphqlTestContext>({
      schema: options.schema,
      graphqlEndpoint: path,
      graphiql: false,
      landingPage: false,
      logging: false,
      maskedErrors: false,
      context: (initial) =>
        captureRequest(initial, requests).then((request) => ({
          request,
        })),
    });

    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.promise(() => Promise.resolve(yoga.handle(webRequest, {})));
        return HttpServerResponse.fromWeb(response);
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text("GraphQL test server failed", {
              status: 500,
              contentType: "text/plain",
            }),
          ),
        ),
      ),
    ).pipe(
      Effect.mapError((error) =>
        Predicate.isTagged(error, "TestHttpServerAddressError")
          ? new GraphqlTestServerAddressError({ address: error.address })
          : new GraphqlTestServerHandlerError({ cause: error.cause }),
      ),
    );

    return {
      endpoint: server.url(path),
      schema: options.schema,
      requests: Ref.get(requests),
      clearRequests: Ref.set(requests, []),
    };
  });

export class GraphqlTestServer extends Context.Service<GraphqlTestServer, GraphqlTestServerShape>()(
  "@executor-js/plugin-graphql/testing/GraphqlTestServer",
) {
  static readonly layer = (options: GraphqlTestServerOptions) =>
    Layer.effect(GraphqlTestServer, serveGraphqlTestServer(options));
}

const stringArgument = (
  args: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string,
): string => {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
};

export const makeGreetingGraphqlSchema = (): GraphQLSchema => {
  const Query = new GraphQLObjectType<unknown, GraphqlTestContext>({
    name: "Query",
    fields: {
      hello: {
        type: GraphQLString,
        description: "Say hello",
        args: {
          name: { type: GraphQLString },
        },
        resolve: (_source, args) => `Hello ${stringArgument(args, "name", "world")}`,
      },
    },
  });

  const Mutation = new GraphQLObjectType<unknown, GraphqlTestContext>({
    name: "Mutation",
    fields: {
      setGreeting: {
        type: GraphQLString,
        description: "Set greeting message",
        args: {
          message: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve: (_source, args) => stringArgument(args, "message", ""),
      },
    },
  });

  return new GraphQLSchema({ query: Query, mutation: Mutation });
};

export const TestLayers = {
  greeting: () => GraphqlTestServer.layer({ schema: makeGreetingGraphqlSchema() }),
};
