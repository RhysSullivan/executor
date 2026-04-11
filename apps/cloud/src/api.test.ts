import {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApp,
  HttpClient,
  HttpServer,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
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
  HttpApiEndpoint.get("ping", "/org/ping").addSuccess(SourceResponse),
);
const OrgTestApi = HttpApi.make("orgApi").add(OrgGroup);
const OrgTestHandlers = HttpApiBuilder.group(OrgTestApi, "org", (handlers) =>
  handlers.handle("ping", () => Effect.succeed({ source: "org" })),
);

const AuthGroup = HttpApiGroup.make("auth").add(
  HttpApiEndpoint.get("me", "/auth/me").addSuccess(SourceResponse),
);
const AuthApi = HttpApi.make("authApi").add(AuthGroup);
const AuthHandlers = HttpApiBuilder.group(AuthApi, "auth", (handlers) =>
  handlers.handle("me", () => Effect.succeed({ source: "auth" })),
);

const ProtectedGroup = HttpApiGroup.make("protected")
  .add(HttpApiEndpoint.get("scope", "/scope").addSuccess(SourceResponse))
  .add(
    HttpApiEndpoint.post("resume", "/executions/:executionId/resume")
      .setPath(Schema.Struct({ executionId: Schema.String }))
      .addSuccess(SourceResponse),
  );
const ProtectedApi = HttpApi.make("protectedApi").add(ProtectedGroup);
const ProtectedHandlers = HttpApiBuilder.group(ProtectedApi, "protected", (handlers) =>
  handlers
    .handle("scope", () => Effect.succeed({ source: "protected" }))
    .handle("resume", () => Effect.succeed({ source: "protected" })),
);

const OrgTestApp = Effect.flatMap(
  HttpApiBuilder.httpApp.pipe(
    Effect.provide(
      HttpApiBuilder.api(OrgTestApi).pipe(
        Layer.provide(OrgTestHandlers),
        Layer.provideMerge(HttpServer.layerContext),
        Layer.provideMerge(HttpApiBuilder.Router.Live),
        Layer.provideMerge(HttpApiBuilder.Middleware.layer),
      ),
    ),
  ),
  (app) => app,
).pipe(Effect.provide(HttpServer.layerContext));

const AuthTestApp = Effect.flatMap(
  HttpApiBuilder.httpApp.pipe(
    Effect.provide(
      HttpApiBuilder.api(AuthApi).pipe(
        Layer.provide(AuthHandlers),
        Layer.provideMerge(HttpServer.layerContext),
        Layer.provideMerge(HttpApiBuilder.Router.Live),
        Layer.provideMerge(HttpApiBuilder.Middleware.layer),
      ),
    ),
  ),
  (app) => app,
).pipe(Effect.provide(HttpServer.layerContext));

const ProtectedBaseTestApp = Effect.flatMap(
  HttpApiBuilder.httpApp.pipe(
    Effect.provide(
      HttpApiBuilder.api(ProtectedApi).pipe(
        Layer.provide(ProtectedHandlers),
        Layer.provideMerge(HttpServer.layerContext),
        Layer.provideMerge(HttpApiBuilder.Router.Live),
        Layer.provideMerge(HttpApiBuilder.Middleware.layer),
      ),
    ),
  ),
  (app) => app,
).pipe(Effect.provide(HttpServer.layerContext));

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
    return HttpServerResponse.unsafeJson(
      { error: "No organization in session", code: "no_organization" },
      { status: 403 },
    );
  }
  if (testState.mode === "error") {
    return HttpServerResponse.unsafeJson({ error: "boom" }, { status: 500 });
  }
  if (testState.mode === "bad-status") {
    return HttpServerResponse.unsafeJson({ source: "protected" }, { status: 400 });
  }
  return yield* ProtectedBaseTestApp;
});

const TestRequestHandlersLive = Layer.mergeAll(
  Layer.succeed(OrgRequestHandlerService, { app: OrgTestApp }),
  Layer.succeed(NonProtectedRequestHandlerService, { app: AuthTestApp }),
  Layer.succeed(AutumnRequestHandlerService, {
    app: Effect.succeed(HttpServerResponse.unsafeJson({ source: "autumn" })),
  }),
  Layer.succeed(ProtectedRequestHandlerService, { app: ProtectedTestApp }),
);

const requestHandler = Effect.runSync(Effect.provide(ApiRequestHandler, TestRequestHandlersLive));

const TestApi = HttpApi.make("testApi")
  .add(OrgGroup)
  .add(AuthGroup)
  .add(
    HttpApiGroup.make("autumn").add(
      HttpApiEndpoint.get("plans", "/autumn/plans").addSuccess(SourceResponse),
    ),
  )
  .add(ProtectedGroup);

const TestServerLayer = HttpServer.serve(HttpApp.fromWebHandler(requestHandler)).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

const getClient = () => HttpApiClient.make(TestApi);

layer(TestServerLayer)("handleApiRequest", (it) => {
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

      const response = yield* HttpClient.get("/scope");
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
      const result = yield* client.protected.resume({ path: { executionId: "exec_1" } });
      expect(result).toEqual({ source: "protected" });
    }),
  );

  it.effect("returns protected response status as-is", () =>
    Effect.gen(function* () {
      resetState();
      testState.mode = "bad-status";

      const response = yield* HttpClient.post("/executions/exec_1/resume");
      expect(response.status).toBe(400);
    }),
  );

  it.effect("returns 500 JSON when protected request handling throws", () =>
    Effect.gen(function* () {
      resetState();
      testState.mode = "error";

      const response = yield* HttpClient.get("/scope");
      expect(response.status).toBe(500);
      const body = yield* response.json;
      expect(body).toEqual({ error: "boom" });
    }),
  );
});
