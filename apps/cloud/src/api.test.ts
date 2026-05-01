import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpEffect, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import {
  ApiRequestHandler,
  AutumnRequestHandlerService,
  NonProtectedRequestHandlerService,
  ProtectedRequestHandlerService,
  OrgRequestHandlerService,
} from "./api/router";

const SourceResponse = Schema.Struct({ source: Schema.String });

const OrgGroup = HttpApiGroup.make("org").add(
  HttpApiEndpoint.get("ping", "/org/ping", { success: SourceResponse }),
);
const OrgTestApi = HttpApi.make("orgApi").add(OrgGroup);
const OrgTestHandlers = HttpApiBuilder.group(OrgTestApi, "org", (handlers) =>
  handlers.handle("ping", () => Effect.succeed({ source: "org" })),
);

const AuthGroup = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.get("me", "/auth/me", { success: SourceResponse }),
);
const AuthApi = HttpApi.make("authApi").add(AuthGroup);
const AuthHandlers = HttpApiBuilder.group(AuthApi, "auth", (handlers) =>
  handlers.handle("me", () => Effect.succeed({ source: "auth" })),
);

const ProtectedGroup = HttpApiGroup.make("protected")
  .add(HttpApiEndpoint.get("scope", "/scope", { success: SourceResponse }))
  .add(
    HttpApiEndpoint.post("resume", "/executions/:executionId/resume", {
      params: { executionId: Schema.String },
      success: SourceResponse,
    }),
  );
const ProtectedApi = HttpApi.make("protectedApi").add(ProtectedGroup);
const ProtectedHandlers = HttpApiBuilder.group(ProtectedApi, "protected", (handlers) =>
  handlers
    .handle("scope", () => Effect.succeed({ source: "protected" }))
    .handle("resume", () => Effect.succeed({ source: "protected" })),
);

const toHttpApp = (
  apiLayer: Parameters<typeof HttpRouter.toWebHandler>[0],
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const web = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
    const response = yield* Effect.promise(() => web.handler(webRequest, undefined));
    return HttpServerResponse.raw(response, { status: response.status, headers: response.headers });
  });

const OrgTestApp = toHttpApp(
  HttpApiBuilder.layer(OrgTestApi).pipe(
    Layer.provide(OrgTestHandlers),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
  ) as Parameters<typeof HttpRouter.toWebHandler>[0],
);

const AuthTestApp = toHttpApp(
  HttpApiBuilder.layer(AuthApi).pipe(
    Layer.provide(AuthHandlers),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
  ) as Parameters<typeof HttpRouter.toWebHandler>[0],
);

const ProtectedBaseTestApp = toHttpApp(
  HttpApiBuilder.layer(ProtectedApi).pipe(
    Layer.provide(ProtectedHandlers),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
  ) as Parameters<typeof HttpRouter.toWebHandler>[0],
);

type ProtectedMode = "ok" | "none" | "error" | "bad-status";

const testState: {
  mode: ProtectedMode;
} = {
  mode: "ok",
};

const resetState = () => {
  testState.mode = "ok";
};

const ProtectedTestApp = Effect.gen(function* () {
  if (testState.mode === "none") {
    return HttpServerResponse.jsonUnsafe(
      { error: "No organization in session", code: "no_organization" },
      { status: 403 },
    );
  }
  if (testState.mode === "error") {
    return HttpServerResponse.jsonUnsafe({ error: "boom" }, { status: 500 });
  }
  if (testState.mode === "bad-status") {
    return HttpServerResponse.jsonUnsafe({ source: "protected" }, { status: 400 });
  }
  return yield* ProtectedBaseTestApp;
});

const TestRequestHandlersLive = Layer.mergeAll(
  Layer.succeed(OrgRequestHandlerService)({ app: OrgTestApp }),
  Layer.succeed(NonProtectedRequestHandlerService)({ app: AuthTestApp }),
  Layer.succeed(AutumnRequestHandlerService)({
    app: Effect.succeed(HttpServerResponse.jsonUnsafe({ source: "autumn" })),
  }),
  Layer.succeed(ProtectedRequestHandlerService)({ app: ProtectedTestApp }),
);

const requestHandler = Effect.runSync(
  Effect.map(
    Effect.provide(ApiRequestHandler, TestRequestHandlersLive),
    (app) => HttpEffect.toWebHandler(app),
  ),
);

const TestApi = HttpApi.make("testApi")
  .add(OrgGroup)
  .add(AuthGroup)
  .add(
    HttpApiGroup.make("autumn").add(
      HttpApiEndpoint.get("plans", "/autumn/plans", { success: SourceResponse }),
    ),
  )
  .add(ProtectedGroup);

// Route HttpClient calls directly through the web handler — no real HTTP
// server, so the suite runs in any runtime (including workerd, where
// NodeHttpServer.layerTest crashes the isolate).
const TEST_BASE_URL = "http://test.local";
const fetchViaHandler: typeof globalThis.fetch = (input, init) =>
  requestHandler(input instanceof Request ? input : new Request(input, init));

const TestClientLayer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetchViaHandler)),
);

const getClient = () => HttpApiClient.make(TestApi, { baseUrl: TEST_BASE_URL });

layer(TestClientLayer)("handleApiRequest", (it) => {
  it.effect("routes /org/* to the org API handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.org.ping();
      expect(result).toEqual({ source: "org" });
    }),
  );

  it.effect("routes /auth/* to the auth API handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.auth.me();
      expect(result).toEqual({ source: "auth" });
    }),
  );

  it.effect("routes /autumn/* to the autumn handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.autumn.plans();
      expect(result).toEqual({ source: "autumn" });
    }),
  );

  it.effect("routes non-auth paths to protected handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.protected.scope();
      expect(result).toEqual({ source: "protected" });
    }),
  );

  it.effect("returns 403 when protected handler returns no organization", () =>
    Effect.gen(function* () {
      resetState();
      testState.mode = "none";

      const response = yield* HttpClient.get(`${TEST_BASE_URL}/scope`);
      expect(response.status).toBe(403);
      const body = yield* response.json;
      expect(body).toEqual({
        error: "No organization in session",
        code: "no_organization",
      });
    }),
  );

  it.effect("routes resume paths to protected handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.protected.resume({ params: { executionId: "exec_1" } });
      expect(result).toEqual({ source: "protected" });
    }),
  );

  it.effect("returns protected response status as-is", () =>
    Effect.gen(function* () {
      resetState();
      testState.mode = "bad-status";

      const response = yield* HttpClient.post(`${TEST_BASE_URL}/executions/exec_1/resume`);
      expect(response.status).toBe(400);
    }),
  );

  it.effect("returns 500 JSON when protected request handling throws", () =>
    Effect.gen(function* () {
      resetState();
      testState.mode = "error";

      const response = yield* HttpClient.get(`${TEST_BASE_URL}/scope`);
      expect(response.status).toBe(500);
      const body = yield* response.json;
      expect(body).toEqual({ error: "boom" });
    }),
  );
});
