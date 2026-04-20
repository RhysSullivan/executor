// ---------------------------------------------------------------------------
// End-to-end shape test for multi-scope OAuth on the OpenAPI plugin.
//
// Models the production scenario: an org-level admin uploads the shared
// client credentials, each member of the org runs their own OAuth flow,
// and each member's access token is stamped at the per-user scope so the
// org fallback provides client id/secret and the user scope provides
// the access token the invoker actually injects.
//
// Three executors share a single backing adapter + blob store + secret
// provider:
//   - admin: scopes = [org]
//   - alice: scopes = [user-a, org]
//   - bob:   scopes = [user-b, org]
//
// Expectations:
//   1. Admin writes `petstore_client_id`/`petstore_client_secret` at org.
//   2. Both users addSpec at their own scope with OAuth2Auth referencing
//      the shared org client secrets + user-unique access/refresh token ids.
//   3. Each user runs startOAuth / completeOAuth; tokens land at their
//      own scope via the session's `tokenScope`.
//   4. Invoking `petstore.items.echoHeaders` through alice returns
//      alice's token; through bob returns bob's.
//   5. `secrets.list()` for alice surfaces the org client creds + her
//      own tokens but NOT bob's.
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

import { OAuth2Auth } from "./types";
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
    // Omit `expires_in` so the resulting OAuth2Auth has expiresAt=null.
    // That sidesteps the refresh path during invocation — the invoker
    // returns the stored access token directly.
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
    "per-user access tokens coexist with a shared org-level client credential",
    () =>
      Effect.gen(function* () {
        // Shared secret provider. No `list()` implementation — we don't
        // want the scope-agnostic provider-enumeration fallback to leak
        // user-scoped ids across executors during this test. In
        // production, providers that enumerate (1password, workos-vault)
        // partition by their own tenancy; the in-memory provider here
        // is flat, so removing `list()` keeps the core-table walk the
        // only resolver.
        const secretStore = new Map<string, string>();
        const key = (scope: string, id: string) => `${scope}\u0000${id}`;
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

        // Route OpenAPI tool invocations through the Effect test server.
        const httpClient = yield* HttpClient.HttpClient;
        const clientLayer = Layer.succeed(HttpClient.HttpClient, httpClient);
        const plugins = [
          openApiPlugin({ httpClientLayer: clientLayer }),
          memorySecretsPlugin(),
        ] as const;

        // One adapter + blob store behind all three executors — exactly
        // what a multi-tenant deployment looks like in production.
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
        // 2. Each user adds the petstore source at their own scope,
        //    pre-populating OAuth2Auth that points at:
        //      - shared org client creds (read via scope fallthrough)
        //      - user-unique access/refresh token ids (read directly
        //        from the user scope).
        //    `expiresAt: null` keeps the invoker on the no-refresh
        //    path — it returns the stored access token verbatim.
        // -------------------------------------------------------------
        const makeAuth = (user: "alice" | "bob"): OAuth2Auth =>
          new OAuth2Auth({
            kind: "oauth2",
            securitySchemeName: "oauth2",
            flow: "authorizationCode",
            tokenUrl: "https://token.example.com/token",
            clientIdSecretId: "petstore_client_id",
            clientSecretSecretId: "petstore_client_secret",
            accessTokenSecretId: `petstore_access_token_${user}`,
            refreshTokenSecretId: `petstore_refresh_token_${user}`,
            tokenType: "Bearer",
            expiresAt: null,
            scope: null,
            scopes: ["read"],
          });

        yield* aliceExec.openapi.addSpec({
          spec: specJson,
          scope: aliceScope.id as string,
          namespace: "petstore",
          baseUrl: "",
          oauth2: makeAuth("alice"),
        });
        yield* bobExec.openapi.addSpec({
          spec: specJson,
          scope: bobScope.id as string,
          namespace: "petstore",
          baseUrl: "",
          oauth2: makeAuth("bob"),
        });

        // -------------------------------------------------------------
        // 3. Each user runs the OAuth flow. Mock the token endpoint to
        //    return a distinct access_token per `code` so we can tell
        //    them apart downstream.
        // -------------------------------------------------------------
        mockTokenFetch({
          "code-alice": "alice-token",
          "code-bob": "bob-token",
        });

        const startInputFor = (user: "alice" | "bob", scope: ScopeId) => ({
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
          accessTokenSecretId: `petstore_access_token_${user}`,
          refreshTokenSecretId: `petstore_refresh_token_${user}`,
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

        yield* aliceExec.openapi.completeOAuth({
          state: aliceStart.sessionId,
          code: "code-alice",
        });
        yield* bobExec.openapi.completeOAuth({
          state: bobStart.sessionId,
          code: "code-bob",
        });

        // -------------------------------------------------------------
        // 4. Invoke the tool through each executor. The injected
        //    Authorization header must carry THAT user's token.
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
        // 5. Scope isolation on `secrets.list()`:
        //    - alice sees org client creds + her own tokens.
        //    - alice does NOT see bob's tokens.
        //    - bob symmetrically sees only the org creds + his tokens.
        //    - admin sees only the org creds.
        // -------------------------------------------------------------
        const aliceIds = new Set(
          (yield* aliceExec.secrets.list()).map((s) => s.id as unknown as string),
        );
        expect(aliceIds).toContain("petstore_client_id");
        expect(aliceIds).toContain("petstore_client_secret");
        expect(aliceIds).toContain("petstore_access_token_alice");
        expect(aliceIds).toContain("petstore_refresh_token_alice");
        expect(aliceIds).not.toContain("petstore_access_token_bob");
        expect(aliceIds).not.toContain("petstore_refresh_token_bob");

        const bobIds = new Set(
          (yield* bobExec.secrets.list()).map((s) => s.id as unknown as string),
        );
        expect(bobIds).toContain("petstore_client_id");
        expect(bobIds).toContain("petstore_access_token_bob");
        expect(bobIds).toContain("petstore_refresh_token_bob");
        expect(bobIds).not.toContain("petstore_access_token_alice");

        const adminIds = new Set(
          (yield* adminExec.secrets.list()).map((s) => s.id as unknown as string),
        );
        expect(adminIds).toContain("petstore_client_id");
        expect(adminIds).toContain("petstore_client_secret");
        expect(adminIds).not.toContain("petstore_access_token_alice");
        expect(adminIds).not.toContain("petstore_access_token_bob");

        // -------------------------------------------------------------
        // 6. Secret-row scope attribution: alice's tokens are pinned to
        //    her scope, not smuggled in under the org fallback.
        // -------------------------------------------------------------
        const aliceRows = yield* aliceExec.secrets.list();
        const aliceAccess = aliceRows.find(
          (r) => (r.id as unknown as string) === "petstore_access_token_alice",
        );
        expect(aliceAccess?.scopeId as unknown as string).toBe("user-alice");
        const aliceClient = aliceRows.find(
          (r) => (r.id as unknown as string) === "petstore_client_id",
        );
        expect(aliceClient?.scopeId as unknown as string).toBe("org");
      }),
  );
});
