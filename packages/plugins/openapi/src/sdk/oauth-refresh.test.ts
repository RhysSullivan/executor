// ---------------------------------------------------------------------------
// End-to-end refresh behaviour for the OpenAPI plugin's oauth2 connection
// provider.
//
// The existing `multi-scope-oauth.test.ts` covers sign-in isolation; this
// file focuses on RFC 6749 §6 refresh behaviour at the plugin boundary:
//
//   1. An expired access_token is refreshed transparently before invoke.
//   2. Concurrent invokes collapse to a single `grant_type=refresh_token`
//      POST — the SDK's dedup applies to the plugin's provider.
//   3. `invalid_grant` from the token endpoint surfaces as
//      `ConnectionReauthRequiredError` so the UI can prompt sign-in.
// ---------------------------------------------------------------------------

import { afterEach, expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import { NodeHttpServer } from "@effect/platform-node";

import {
  ConnectionId,
  ConnectionReauthRequiredError,
  CreateConnectionInput,
  ScopeId,
  SecretId,
  Scope,
  SetSecretInput,
  TokenMaterial,
  collectSchemas,
  createExecutor,
  definePlugin,
  makeInMemoryBlobStore,
  type InvokeOptions,
  type SecretProvider,
} from "@executor-js/sdk";
import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { openApiPlugin } from "./plugin";
import { OAuth2Auth } from "./types";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// Test API — one endpoint that echoes the Authorization header so we can
// prove which access token was in flight at invoke time.
// ---------------------------------------------------------------------------

class EchoHeaders extends Schema.Class<EchoHeaders>("EchoHeaders")({
  authorization: Schema.optional(Schema.String),
}) {}

const ItemsGroup = HttpApiGroup.make("items").add(
  HttpApiEndpoint.get("echoHeaders", "/echo-headers", { success: EchoHeaders }),
);

const TestApi = HttpApi.make("testApi").add(ItemsGroup);
const specJson = JSON.stringify(OpenApi.fromApi(TestApi));

const ItemsGroupLive = HttpApiBuilder.group(TestApi, "items", (handlers) =>
  handlers.handle("echoHeaders", () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return new EchoHeaders({
        authorization: req.headers["authorization"],
      });
    }),
  ),
);

const ApiLive = HttpApiBuilder.layer(TestApi).pipe(Layer.provide(ItemsGroupLive));

const TestLayer = HttpRouter.serve(ApiLive, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

// ---------------------------------------------------------------------------
// Token-endpoint mock. Callers supply a handler that sees the parsed body
// (grant_type, refresh_token, ...) and returns either an RFC 6749 success
// response or an error envelope. `calls` records every hit for assertions.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

type TokenCall = {
  readonly body: URLSearchParams;
};

const mockTokenFetch = (
  handler: (body: URLSearchParams) => Effect.Effect<Response, never, never> | Promise<Response>,
) => {
  const calls: TokenCall[] = [];
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof _input === "string" ? _input : _input.toString();
    if (!url.includes("token.example.com")) {
      return originalFetch(_input, init);
    }
    const bodyText =
      init?.body instanceof URLSearchParams
        ? init.body.toString()
        : typeof init?.body === "string"
          ? init.body
          : "";
    const body = new URLSearchParams(bodyText);
    calls.push({ body });
    const out = handler(body);
    if (Effect.isEffect(out)) return await Effect.runPromise(out);
    return await out;
  }, { preconnect: originalFetch.preconnect });
  return { calls };
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Fixture builder. Wires up a single-scope executor with an in-memory
// secrets provider, the openApi plugin pointed at a live HttpClient, and
// seeds an expired oauth2 Connection + source pointing at that server.
// ---------------------------------------------------------------------------

const makeExecutor = () =>
  Effect.gen(function* () {
    const secretStore = new Map<string, string>();
    const keyOf = (scope: string, id: string) => `${scope} ${id}`;
    const memoryProvider: SecretProvider = {
      key: "memory",
      writable: true,
      get: (id, scope) =>
        Effect.sync(() => secretStore.get(keyOf(scope, id)) ?? null),
      set: (id, value, scope) =>
        Effect.sync(() => {
          secretStore.set(keyOf(scope, id), value);
        }),
      delete: (id, scope) =>
        Effect.sync(() => secretStore.delete(keyOf(scope, id))),
    };
    const memorySecretsPlugin = definePlugin(() => ({
      id: "memory-secrets" as const,
      storage: () => ({}),
      secretProviders: [memoryProvider],
    }));
      const clientLayer = FetchHttpClient.layer;
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (address._tag !== "TcpAddress") return yield* Effect.die("test server must bind to TCP");
      const baseUrl = `http://127.0.0.1:${address.port}`;
    const plugins = [
      openApiPlugin({ httpClientLayer: clientLayer }),
      memorySecretsPlugin(),
    ] as const;

    const schema = collectSchemas(plugins);
    const adapter = makeMemoryAdapter({ schema });
    const blobs = makeInMemoryBlobStore();

    const scopeId = ScopeId.make("test-scope");
    const scope = new Scope({
      id: scopeId,
      name: "test",
      createdAt: new Date(),
    });
    const executor = yield* createExecutor({
      scopes: [scope],
      adapter,
      blobs,
      plugins,
    });

    // Seed client id + secret in the executor scope so the openapi
    // provider's refresh can resolve them.
    yield* executor.secrets.set(
      new SetSecretInput({
        id: SecretId.make("client_id"),
        scope: scopeId,
        name: "Client ID",
        value: "abc",
      }),
    );
    yield* executor.secrets.set(
      new SetSecretInput({
        id: SecretId.make("client_secret"),
        scope: scopeId,
        name: "Client Secret",
        value: "shhh",
      }),
    );

    return { executor, scopeId, baseUrl };
  });

type EffectSuccess<T> = T extends Effect.Effect<infer A, unknown, unknown> ? A : never;

type ExecutorValue = EffectSuccess<ReturnType<typeof makeExecutor>>["executor"];

// Seed an authorizationCode Connection with an already-expired access
// token and a stored refresh token. The test's mock token endpoint
// decides what comes back on `grant_type=refresh_token`.
const seedExpiredConnection = (
  executor: ExecutorValue,
  scopeId: ScopeId,
  connectionId: string,
) =>
  Effect.gen(function* () {
    yield* executor.connections.create(
      new CreateConnectionInput({
        id: ConnectionId.make(connectionId),
        scope: scopeId,
        provider: "openapi:oauth2",
        identityLabel: "Alice",
        accessToken: new TokenMaterial({
          secretId: SecretId.make(`${connectionId}.access_token`),
          name: "Access",
          value: "expired-access-v1",
        }),
        refreshToken: new TokenMaterial({
          secretId: SecretId.make(`${connectionId}.refresh_token`),
          name: "Refresh",
          value: "refresh-v1",
        }),
        expiresAt: Date.now() - 10_000,
        oauthScope: "read",
        providerState: {
          flow: "authorizationCode",
          tokenUrl: "https://token.example.com/token",
          clientIdSecretId: "client_id",
          clientSecretSecretId: "client_secret",
          scopes: ["read"],
        },
      }),
    );
    return new OAuth2Auth({
      kind: "oauth2",
      connectionId,
      securitySchemeName: "oauth2",
      flow: "authorizationCode",
      tokenUrl: "https://token.example.com/token",
      authorizationUrl: "https://auth.example.com/authorize",
      clientIdSecretId: "client_id",
      clientSecretSecretId: "client_secret",
      scopes: ["read"],
    });
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestLayer)("OpenAPI oauth refresh", (it) => {
  it.effect(
    "expired access_token is refreshed via grant_type=refresh_token before invoke",
    () =>
      Effect.gen(function* () {
        const { executor, scopeId, baseUrl } = yield* makeExecutor();
        const { calls } = mockTokenFetch(
          () =>
            Effect.succeed(
              new Response(
                JSON.stringify({
                  access_token: "fresh-access-v2",
                  token_type: "Bearer",
                  refresh_token: "refresh-v2",
                  expires_in: 3600,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            ),
        );

        const auth = yield* seedExpiredConnection(
          executor,
          scopeId,
          "conn-refresh-ok",
        );

        yield* executor.openapi.addSpec({
          spec: specJson,
          scope: String(scopeId),
          namespace: "petstore",
          baseUrl,
          oauth2: auth,
        });

        const result = (yield* executor.tools.invoke(
          "petstore.items.echoHeaders",
          {},
          autoApprove,
        )) as { data: { authorization?: string } | null; error: unknown };

        expect(result.error).toBeNull();
        // Proves the refresh landed: invoke carried the fresh token,
        // not the expired one we seeded.
        expect(result.data?.authorization).toBe("Bearer fresh-access-v2");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.body.get("grant_type")).toBe("refresh_token");
        expect(calls[0]!.body.get("refresh_token")).toBe("refresh-v1");

        // Connection row is patched with the new expiry so the next
        // invoke in-window doesn't trip a second refresh.
        const conn = yield* executor.connections.get("conn-refresh-ok");
        expect(conn).not.toBeNull();
        expect(conn!.expiresAt).not.toBeNull();
        expect(conn!.expiresAt!).toBeGreaterThan(Date.now() + 3_000_000);
      }),
  );

  it.effect(
    "concurrent invokes with an expired token issue exactly one refresh",
    () =>
      Effect.gen(function* () {
        const { executor, scopeId, baseUrl } = yield* makeExecutor();
        const { calls } = mockTokenFetch(
          () =>
            Effect.succeed(
              new Response(
                JSON.stringify({
                  access_token: "fresh-access-v2",
                  token_type: "Bearer",
                  refresh_token: "refresh-v2",
                  expires_in: 3600,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            ),
        );

        const auth = yield* seedExpiredConnection(
          executor,
          scopeId,
          "conn-refresh-concurrent",
        );

        yield* executor.openapi.addSpec({
          spec: specJson,
          scope: String(scopeId),
          namespace: "petstore",
          baseUrl,
          oauth2: auth,
        });

        const invokes = yield* Effect.all(
          [1, 2, 3, 4, 5].map(() =>
            executor.tools.invoke(
              "petstore.items.echoHeaders",
              {},
              autoApprove,
            ),
          ),
          { concurrency: "unbounded" },
        );

        for (const r of invokes) {
          const res = r as {
            data: { authorization?: string } | null;
            error: unknown;
          };
          expect(res.error).toBeNull();
          expect(res.data?.authorization).toBe("Bearer fresh-access-v2");
        }
        // Critical assertion: the SDK's dedup collapses every parallel
        // invoke into one call to the token endpoint. Anything more
        // means we're hammering the AS under load.
        expect(calls).toHaveLength(1);
      }),
  );

  it.effect(
    "invalid_grant from refresh surfaces as ConnectionReauthRequiredError",
    () =>
      Effect.gen(function* () {
        const { executor, scopeId, baseUrl } = yield* makeExecutor();
        mockTokenFetch(
          () =>
            Effect.succeed(
              new Response(
                JSON.stringify({
                  error: "invalid_grant",
                  error_description: "Refresh token revoked",
                }),
                { status: 400, headers: { "content-type": "application/json" } },
              ),
            ),
        );

        const auth = yield* seedExpiredConnection(
          executor,
          scopeId,
          "conn-refresh-dead",
        );

        yield* executor.openapi.addSpec({
          spec: specJson,
          scope: String(scopeId),
          namespace: "petstore",
          baseUrl,
          oauth2: auth,
        });

        // Tool invocation currently wraps connection errors in a
        // generic Error (see openapi invokeTool), so we assert against
        // the `accessToken` call directly too — that's the surface
        // the UI bridges use to trigger re-auth.
        const flipped = yield* executor.connections
          .accessToken("conn-refresh-dead")
          .pipe(Effect.flip);
        expect(flipped._tag).toBe("ConnectionReauthRequiredError");
        expect((flipped as ConnectionReauthRequiredError).provider).toBe(
          "openapi:oauth2",
        );
        expect(
          (flipped as ConnectionReauthRequiredError).message,
        ).toMatch(/invalid_grant|revoked/i);
      }),
  );
});
