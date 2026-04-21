// ---------------------------------------------------------------------------
// End-to-end shape test for multi-scope OAuth on the OpenAPI plugin.
//
// Models the production scenario: an org-level admin uploads the shared
// client credentials, each member of the org runs their own OAuth flow,
// and each member's access token lives on a per-user Connection. The
// Connections primitive owns every secret — they're filtered out of the
// user-facing `secrets.list()` automatically.
// ---------------------------------------------------------------------------

import { afterEach } from "vitest";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpClient,
  HttpServerRequest,
  OpenApi,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";

import {
  collectSchemas,
  createExecutor,
  definePlugin,
  makeInMemoryBlobStore,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  type InvokeOptions,
  type SecretProvider,
} from "@executor/sdk";
import { makeMemoryAdapter } from "@executor/storage-core/testing/memory";

import { openApiPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// Test API — a single endpoint that echoes the Authorization header so the
// test can assert which user's token got injected.
// ---------------------------------------------------------------------------

class EchoHeaders extends Schema.Class<EchoHeaders>("EchoHeaders")({
  authorization: Schema.optional(Schema.String),
}) {}

const ItemsGroup = HttpApiGroup.make("items").add(
  HttpApiEndpoint.get("echoHeaders", "/echo-headers").addSuccess(EchoHeaders),
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

const ApiLive = HttpApiBuilder.api(TestApi).pipe(Layer.provide(ItemsGroupLive));

const TestLayer = HttpApiBuilder.serve().pipe(
  Layer.provide(ApiLive),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

// ---------------------------------------------------------------------------
// Fetch override for the token endpoint. Each user's OAuth callback code
// deterministically maps to a different access_token in the mock
// response so we can assert per-user isolation at invocation time.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

const mockTokenFetch = (tokenByCode: Record<string, string>) => {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const bodyText =
      init?.body instanceof URLSearchParams
        ? init.body.toString()
        : typeof init?.body === "string"
          ? init.body
          : "";
    const params = new URLSearchParams(bodyText);
    const code = params.get("code") ?? "";
    const token = tokenByCode[code];
    if (!token) {
      return new Response(
        JSON.stringify({ error: "invalid_grant", code }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        access_token: token,
        token_type: "Bearer",
        refresh_token: `${token}-refresh`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestLayer)("OpenAPI multi-scope OAuth", (it) => {
  it.effect(
    "per-user Connections coexist with a shared org-level client credential",
    () =>
      Effect.gen(function* () {
        const secretStore = new Map<string, string>();
        const key = (scope: string, id: string) => `${scope} ${id}`;
        const memoryProvider: SecretProvider = {
          key: "memory",
          writable: true,
          get: (id, scope) =>
            Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
          set: (id, value, scope) =>
            Effect.sync(() => {
              secretStore.set(key(scope, id), value);
            }),
          delete: (id, scope) =>
            Effect.sync(() => secretStore.delete(key(scope, id))),
        };
        const memorySecretsPlugin = definePlugin(() => ({
          id: "memory-secrets" as const,
          storage: () => ({}),
          secretProviders: [memoryProvider],
        }));

        const httpClient = yield* HttpClient.HttpClient;
        const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
        const plugins = [
          openApiPlugin({ httpClientLayer: clientLayer }),
          memorySecretsPlugin(),
        ] as const;

        const schema = collectSchemas(plugins);
        const adapter = makeMemoryAdapter({ schema });
        const blobs = makeInMemoryBlobStore();

        const now = new Date();
        const orgScope = new Scope({
          id: ScopeId.make("org"),
          name: "acme-org",
          createdAt: now,
        });
        const aliceScope = new Scope({
          id: ScopeId.make("user-alice"),
          name: "alice",
          createdAt: now,
        });
        const bobScope = new Scope({
          id: ScopeId.make("user-bob"),
          name: "bob",
          createdAt: now,
        });

        const adminExec = yield* createExecutor({
          scopes: [orgScope],
          adapter,
          blobs,
          plugins,
        });
        const aliceExec = yield* createExecutor({
          scopes: [aliceScope, orgScope],
          adapter,
          blobs,
          plugins,
        });
        const bobExec = yield* createExecutor({
          scopes: [bobScope, orgScope],
          adapter,
          blobs,
          plugins,
        });

        // -------------------------------------------------------------
        // 1. Admin seeds the org-level client credentials.
        // -------------------------------------------------------------
        yield* adminExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("petstore_client_id"),
            scope: orgScope.id,
            name: "Petstore Client ID",
            value: "client-abc",
          }),
        );
        yield* adminExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("petstore_client_secret"),
            scope: orgScope.id,
            name: "Petstore Client Secret",
            value: "secret-xyz",
          }),
        );

        // -------------------------------------------------------------
        // 2. Each user runs startOAuth + completeOAuth to mint a
        //    per-user Connection.
        // -------------------------------------------------------------
        mockTokenFetch({
          "code-alice": "alice-token",
          "code-bob": "bob-token",
        });

        const startInputFor = (user: string, scope: ScopeId) => ({
          displayName: `Petstore (${user})`,
          securitySchemeName: "oauth2",
          flow: "authorizationCode" as const,
          authorizationUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://token.example.com/token",
          redirectUrl: "https://app.example.com/oauth/callback",
          clientIdSecretId: "petstore_client_id",
          clientSecretSecretId: "petstore_client_secret",
          scopes: ["read"],
          tokenScope: scope as unknown as string,
        });

        const aliceStart = yield* aliceExec.openapi.startOAuth(
          startInputFor("alice", aliceScope.id),
        );
        const bobStart = yield* bobExec.openapi.startOAuth(
          startInputFor("bob", bobScope.id),
        );
        if (aliceStart.flow !== "authorizationCode") {
          throw new Error("expected authorizationCode flow for alice");
        }
        if (bobStart.flow !== "authorizationCode") {
          throw new Error("expected authorizationCode flow for bob");
        }

        const aliceAuth = yield* aliceExec.openapi.completeOAuth({
          state: aliceStart.sessionId,
          code: "code-alice",
        });
        const bobAuth = yield* bobExec.openapi.completeOAuth({
          state: bobStart.sessionId,
          code: "code-bob",
        });

        expect(aliceAuth.connectionId).not.toBe(bobAuth.connectionId);

        // -------------------------------------------------------------
        // 3. Each user adds the spec with the auth they just minted.
        // -------------------------------------------------------------
        yield* aliceExec.openapi.addSpec({
          spec: specJson,
          scope: aliceScope.id as string,
          namespace: "petstore",
          baseUrl: "",
          oauth2: aliceAuth,
        });
        yield* bobExec.openapi.addSpec({
          spec: specJson,
          scope: bobScope.id as string,
          namespace: "petstore",
          baseUrl: "",
          oauth2: bobAuth,
        });

        // -------------------------------------------------------------
        // 4. Invoke through each exec — Authorization must carry that
        //    user's token.
        // -------------------------------------------------------------
        const aliceResult = (yield* aliceExec.tools.invoke(
          "petstore.items.echoHeaders",
          {},
          autoApprove,
        )) as { data: { authorization?: string } | null; error: unknown };
        expect(aliceResult.error).toBeNull();
        expect(aliceResult.data?.authorization).toBe("Bearer alice-token");

        const bobResult = (yield* bobExec.tools.invoke(
          "petstore.items.echoHeaders",
          {},
          autoApprove,
        )) as { data: { authorization?: string } | null; error: unknown };
        expect(bobResult.error).toBeNull();
        expect(bobResult.data?.authorization).toBe("Bearer bob-token");

        // -------------------------------------------------------------
        // 5. Each user's Connection is scoped to them; admin sees none.
        // -------------------------------------------------------------
        const aliceConnections = yield* aliceExec.connections.list();
        const aliceConn = aliceConnections.find(
          (c) => c.id === aliceAuth.connectionId,
        );
        expect(aliceConn?.scopeId as unknown as string).toBe("user-alice");
        expect(aliceConn?.kind).toBe("user");

        const bobConnections = yield* bobExec.connections.list();
        const bobConn = bobConnections.find(
          (c) => c.id === bobAuth.connectionId,
        );
        expect(bobConn?.scopeId as unknown as string).toBe("user-bob");

        const adminConnectionIds = new Set(
          (yield* adminExec.connections.list()).map((c) => c.id as string),
        );
        expect(adminConnectionIds).not.toContain(
          aliceAuth.connectionId as unknown as string,
        );
        expect(adminConnectionIds).not.toContain(
          bobAuth.connectionId as unknown as string,
        );

        // -------------------------------------------------------------
        // 6. Connection-owned secrets are filtered from secrets.list().
        //    Alice only sees the org client creds; her access / refresh
        //    tokens are hidden behind the Connection primitive.
        // -------------------------------------------------------------
        const aliceSecretIds = new Set(
          (yield* aliceExec.secrets.list()).map(
            (s) => s.id as unknown as string,
          ),
        );
        expect(aliceSecretIds).toContain("petstore_client_id");
        expect(aliceSecretIds).toContain("petstore_client_secret");
        expect(aliceSecretIds).not.toContain(
          `${aliceAuth.connectionId}.access_token`,
        );
        expect(aliceSecretIds).not.toContain(
          `${aliceAuth.connectionId}.refresh_token`,
        );
      }),
  );
});
