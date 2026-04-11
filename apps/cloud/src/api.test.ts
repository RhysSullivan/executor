import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup, HttpApp, HttpClient, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import {
  ApiRequestHandler,
  AutumnRequestHandlerService,
  NonProtectedRequestHandlerService,
  ProtectedRequestHandlerService,
  TeamRequestHandlerService,
} from "./api/router";

const SourceResponse = Schema.Struct({ source: Schema.String });

const TeamGroup = HttpApiGroup.make("team").add(
  HttpApiEndpoint.get("ping", "/team/ping").addSuccess(SourceResponse),
);
const TeamApi = HttpApi.make("teamApi").add(TeamGroup);
const TeamHandlers = HttpApiBuilder.group(TeamApi, "team", (handlers) =>
  handlers.handle("ping", () => Effect.succeed({ source: "team" })),
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

const createTeamTestHandler = () =>
  HttpApiBuilder.toWebHandler(
    HttpApiBuilder.api(TeamApi).pipe(
      Layer.provide(TeamHandlers),
      Layer.provideMerge(HttpServer.layerContext),
    ),
  );

const createAuthTestHandler = () =>
  HttpApiBuilder.toWebHandler(
    HttpApiBuilder.api(AuthApi).pipe(
      Layer.provide(AuthHandlers),
      Layer.provideMerge(HttpServer.layerContext),
    ),
  );

const createProtectedTestHandler = () =>
  HttpApiBuilder.toWebHandler(
    HttpApiBuilder.api(ProtectedApi).pipe(
      Layer.provide(ProtectedHandlers),
      Layer.provideMerge(HttpServer.layerContext),
    ),
  );

type TestWebHandlerFactory = typeof createTeamTestHandler;

const runWithFreshHandler = async (
  createHandler: TestWebHandlerFactory,
  request: Request,
): Promise<Response> => {
  const handler = createHandler();
  try {
    return await handler.handler(request);
  } finally {
    await handler.dispose();
  }
};

type ProtectedMode = "ok" | "none" | "error" | "bad-status";

const testState: {
  mode: ProtectedMode;
} = {
  mode: "ok",
};

const resetState = () => {
  testState.mode = "ok";
};

const handleProtectedTestRequest = async (request: Request) => {
  if (testState.mode === "none") {
    return Response.json(
      { error: "No organization in session", code: "no_organization" },
      { status: 403 },
    );
  }
  if (testState.mode === "error") {
    return Response.json({ error: "boom" }, { status: 500 });
  }

  const handler = createProtectedTestHandler();
  try {
    const response = await handler.handler(request);
    if (testState.mode === "bad-status") {
      return new Response(JSON.stringify({ source: "protected" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return response;
  } finally {
    await handler.dispose();
  }
};

const TestRequestHandlersLive = Layer.mergeAll(
  Layer.succeed(
    TeamRequestHandlerService,
    TeamRequestHandlerService.make({
      handle: (request: Request) => runWithFreshHandler(createTeamTestHandler, request),
    }),
  ),
  Layer.succeed(
    NonProtectedRequestHandlerService,
    NonProtectedRequestHandlerService.make({
      handle: (request: Request) => runWithFreshHandler(createAuthTestHandler, request),
    }),
  ),
  Layer.succeed(
    AutumnRequestHandlerService,
    AutumnRequestHandlerService.make({
      handle: async () => Response.json({ source: "autumn" }),
    }),
  ),
  Layer.succeed(
    ProtectedRequestHandlerService,
    ProtectedRequestHandlerService.make({
      handle: handleProtectedTestRequest,
    }),
  ),
);

const requestHandler = Effect.runSync(Effect.provide(ApiRequestHandler, TestRequestHandlersLive));

const TestApi = HttpApi.make("testApi")
  .add(TeamGroup)
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
  it.effect("routes /team/* to the team API handler", () =>
    Effect.gen(function* () {
      resetState();
      const client = yield* getClient();
      const result = yield* client.team.ping();
      expect(result).toEqual({ source: "team" });
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
