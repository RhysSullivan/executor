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
          sourceId: "petstore",
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

        // With the stable-id fix both users derive the same row id
        // string from `sourceId`, but the rows live at different user
        // scopes (ids are only unique within a scope). The assertion
        // below that `adminConnectionIds` doesn't include either one
        // proves admin's stack can't reach either user's row.
        expect(aliceAuth.connectionId).toBe(bobAuth.connectionId);

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

  // -------------------------------------------------------------------------
  // Regression: repeated `clientCredentials` sign-ins used to mint a fresh
  // random UUID per call AND rewrite `source.oauth2.connectionId` to that
  // new id, which meant whichever user signed in last owned the pointer
  // and everyone else's invocations broke (their scope stack couldn't
  // find the previous signer's row). Fix: the Connection id is now a
  // stable `openapi-oauth2-app-${sourceId}` *name* — the same string
  // across callers — written at the innermost (per-user) scope. Each
  // user's stack resolves that one name to their own physical row via
  // `findInnermostConnectionRow`, so shared source + per-user credentials
  // (secrets shadowed at user scope) keeps producing per-user tokens
  // without clobbering each other.
  // -------------------------------------------------------------------------
  it.effect(
    "clientCredentials sign-in is per-user with a stable shared connection name",
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

        // Org-wide default client_id at org scope. Alice then shadows
        // with her own value at user-alice — the common "per-user API
        // key that uses client_credentials as the wire protocol"
        // pattern. Bob doesn't shadow → he falls through to the org
        // default. This exercises scope-stacked secret resolution.
        yield* adminExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("client_id"),
            scope: orgScope.id,
            name: "Client ID",
            value: "org-client",
          }),
        );
        yield* adminExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("client_secret"),
            scope: orgScope.id,
            name: "Client Secret",
            value: "org-secret",
          }),
        );
        yield* aliceExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("client_id"),
            scope: aliceScope.id,
            name: "Alice Client ID",
            value: "alice-client",
          }),
        );
        yield* aliceExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("client_secret"),
            scope: aliceScope.id,
            name: "Alice Client Secret",
            value: "alice-secret",
          }),
        );

        // client_credentials token endpoint stub. Issues a token that
        // encodes which client_id was used, so we can assert each
        // user's row ends up with a token minted from *their own*
        // credential resolution.
        const tokenCalls: string[] = [];
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
          const bodyText =
            init?.body instanceof URLSearchParams
              ? init.body.toString()
              : typeof init?.body === "string"
                ? init.body
                : "";
          const params = new URLSearchParams(bodyText);
          const clientId = params.get("client_id") ?? "unknown";
          tokenCalls.push(clientId);
          return new Response(
            JSON.stringify({
              access_token: `token-for-${clientId}`,
              token_type: "Bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as unknown as typeof fetch;

        const startInput = {
          sourceId: "petstore",
          connectionId: "shared-petstore-oauth",
          displayName: "Petstore",
          securitySchemeName: "oauth2",
          flow: "clientCredentials" as const,
          tokenUrl: "https://token.example.com/token",
          clientIdSecretId: "client_id",
          clientSecretSecretId: "client_secret",
          scopes: ["read"],
        };

        // Admin adds the org-scoped source with an initial oauth2
        // pointer — same shape the onboarding UI writes via `addSpec`.
        // Admin's scope stack is [org] so their sign-in resolves the
        // org-level creds and writes the connection at org.
        const adminAuth = yield* adminExec.openapi.startOAuth(startInput);
        if (adminAuth.flow !== "clientCredentials") {
          throw new Error("expected clientCredentials flow");
        }
        yield* adminExec.openapi.addSpec({
          spec: specJson,
          scope: orgScope.id as string,
          namespace: "petstore",
          baseUrl: "",
          oauth2: adminAuth.auth,
        });

        // Alice signs in → resolves her shadowed user-scope creds
        // (`alice-client`), mints her own token, writes at user-alice.
        const aliceStart = yield* aliceExec.openapi.startOAuth(startInput);
        if (aliceStart.flow !== "clientCredentials") {
          throw new Error("expected clientCredentials flow for alice");
        }
        // Bob signs in → no user-scope shadow, falls through to the
        // org defaults (`org-client`), writes at user-bob.
        const bobStart = yield* bobExec.openapi.startOAuth(startInput);
        if (bobStart.flow !== "clientCredentials") {
          throw new Error("expected clientCredentials flow for bob");
        }

        // ---- Regression assertions ----

        // (1) All three startOAuth calls return the SAME connection
        // id — it's a stable *name* carried by the source config. No
        // UUID-per-click churn, and the id does not have to be tied to
        // the source namespace.
        const stableId = startInput.connectionId;
        expect(adminAuth.auth.connectionId).toBe(stableId);
        expect(aliceStart.auth.connectionId).toBe(stableId);
        expect(bobStart.auth.connectionId).toBe(stableId);

        // (2) Each user's physical row lives at their own scope. The
        // id *string* collides across scopes intentionally — that's
        // what lets a single `source.oauth2.connectionId` resolve
        // per-caller via `findInnermostConnectionRow`.
        const aliceConn = (yield* aliceExec.connections.list()).find(
          (c) => c.id === stableId && (c.scopeId as unknown as string) === "user-alice",
        );
        const bobConn = (yield* bobExec.connections.list()).find(
          (c) => c.id === stableId && (c.scopeId as unknown as string) === "user-bob",
        );
        const orgConn = (yield* adminExec.connections.list()).find(
          (c) => c.id === stableId,
        );
        expect(aliceConn).toBeDefined();
        expect(bobConn).toBeDefined();
        expect(orgConn).toBeDefined();
        expect(orgConn?.scopeId as unknown as string).toBe("org");

        // (3) Scope-stacked secret resolution produced per-user tokens.
        // The exchange call Alice made used her shadowed value; Bob's
        // fell through to the org default.
        expect(tokenCalls).toContain("alice-client");
        expect(tokenCalls.filter((v) => v === "org-client").length).toBeGreaterThan(
          0,
        );

        // (4) Each user's invocation resolves their OWN row and gets
        // their OWN token — not whatever the last signer happened to
        // mint. This is the core multi-user regression.
        yield* aliceExec.openapi.updateSource(
          "petstore",
          orgScope.id as string,
          { oauth2: aliceStart.auth },
        );
        const aliceResult = (yield* aliceExec.tools.invoke(
          "petstore.items.echoHeaders",
          {},
          autoApprove,
        )) as { data: { authorization?: string } | null; error: unknown };
        expect(aliceResult.error).toBeNull();
        expect(aliceResult.data?.authorization).toBe("Bearer token-for-alice-client");

        const bobResult = (yield* bobExec.tools.invoke(
          "petstore.items.echoHeaders",
          {},
          autoApprove,
        )) as { data: { authorization?: string } | null; error: unknown };
        expect(bobResult.error).toBeNull();
        expect(bobResult.data?.authorization).toBe("Bearer token-for-org-client");

        // (5) Alice's sign-in is idempotent per-user — a repeat click
        // refreshes her one row instead of piling on orphans.
        const countBefore = (yield* aliceExec.connections.list()).filter(
          (c) => c.id === stableId,
        ).length;
        yield* aliceExec.openapi.startOAuth(startInput);
        const countAfter = (yield* aliceExec.connections.list()).filter(
          (c) => c.id === stableId,
        ).length;
        expect(countAfter).toBe(countBefore);
      }),
  );
});
