// ---------------------------------------------------------------------------
// End-to-end shape test for multi-scope OAuth on the OpenAPI plugin.
//
// Models the production scenario: an org-level admin uploads the shared
// client credentials, each member of the org runs their own OAuth flow,
// and each member's access token lives on a per-user Connection. The
// Connections primitive owns every secret — they're filtered out of the
// user-facing `secrets.list()` automatically.
// ---------------------------------------------------------------------------

import { afterEach, expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";

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
} from "@executor-js/sdk";
import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { openApiPlugin } from "./plugin";
import { OAuth2Auth } from "./types";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

// ---------------------------------------------------------------------------
// Test API — a single endpoint that echoes the Authorization header so the
// test can assert which user's token got injected.
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
// Fetch override for the token endpoint. Each user's OAuth callback code
// deterministically maps to a different access_token in the mock
// response so we can assert per-user isolation at invocation time.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

const mockTokenFetch = (tokenByCode: Record<string, string>) => {
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
    const params = new URLSearchParams(bodyText);
    const code = params.get("code") ?? "";
    const token = tokenByCode[code];
    if (!token) {
      return new Response(JSON.stringify({ error: "invalid_grant", code }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        access_token: token,
        token_type: "Bearer",
        refresh_token: `${token}-refresh`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }, { preconnect: originalFetch.preconnect });
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestLayer)("OpenAPI multi-scope OAuth", (it) => {
  it.effect("per-user Connections coexist with a shared org-level client credential", () =>
    Effect.gen(function* () {
      const secretStore = new Map<string, string>();
      const key = (scope: string, id: string) => `${scope} ${id}`;
      const memoryProvider: SecretProvider = {
        key: "memory",
        writable: true,
        get: (id, scope) => Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
        set: (id, value, scope) =>
          Effect.sync(() => {
            secretStore.set(key(scope, id), value);
          }),
        delete: (id, scope) => Effect.sync(() => secretStore.delete(key(scope, id))),
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
        onElicitation: "accept-all",
      });
      const aliceExec = yield* createExecutor({
        scopes: [aliceScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const bobExec = yield* createExecutor({
        scopes: [bobScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
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
      // 2. Each user runs startOAuth + centralized OAuth completion to mint a
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
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://token.example.com/token",
        redirectUrl: "https://app.example.com/oauth/callback",
        clientIdSecretId: "petstore_client_id",
        clientSecretSecretId: "petstore_client_secret",
        scopes: ["read"],
        tokenScope: String(scope),
      });

      const startAuthorizationCode = (
        exec: typeof aliceExec,
        input: ReturnType<typeof startInputFor>,
      ) =>
        exec.oauth.start({
          endpoint: input.authorizationUrl,
          redirectUrl: input.redirectUrl,
          connectionId: `openapi-oauth2-user-${input.sourceId}`,
          tokenScope: input.tokenScope,
          pluginId: "openapi",
          identityLabel: `${input.displayName} OAuth`,
          strategy: {
            kind: "authorization-code",
            authorizationEndpoint: input.authorizationUrl,
            tokenEndpoint: input.tokenUrl,
            issuerUrl: null,
            clientIdSecretId: input.clientIdSecretId,
            clientSecretSecretId: input.clientSecretSecretId,
            scopes: input.scopes,
          },
        });

      const aliceStart = yield* startAuthorizationCode(
        aliceExec,
        startInputFor("alice", aliceScope.id),
      );
      const bobStart = yield* startAuthorizationCode(bobExec, startInputFor("bob", bobScope.id));
      if (aliceStart.authorizationUrl === null) {
        throw new Error("expected authorizationCode flow for alice");
      }
      if (bobStart.authorizationUrl === null) {
        throw new Error("expected authorizationCode flow for bob");
      }

      const aliceAuth = yield* aliceExec.oauth.complete({
        state: aliceStart.sessionId,
        code: "code-alice",
      });
      const bobAuth = yield* bobExec.oauth.complete({
        state: bobStart.sessionId,
        code: "code-bob",
      });

      // With the stable-id fix both users derive the same row id
      // string from `sourceId`, but the rows live at different user
      // scopes (ids are only unique within a scope). The assertion
      // below that `adminConnectionIds` doesn't include either one
      // proves admin's stack can't reach either user's row.
      expect(aliceAuth.connectionId).toBe(bobAuth.connectionId);
      const aliceOAuth2Auth = new OAuth2Auth({
        kind: "oauth2",
        connectionId: aliceAuth.connectionId,
        securitySchemeName: "oauth2",
        flow: "authorizationCode",
        tokenUrl: "https://token.example.com/token",
        authorizationUrl: "https://auth.example.com/authorize",
        clientIdSecretId: "petstore_client_id",
        clientSecretSecretId: "petstore_client_secret",
        scopes: ["read"],
      });
      const bobOAuth2Auth = new OAuth2Auth({
        kind: "oauth2",
        connectionId: bobAuth.connectionId,
        securitySchemeName: "oauth2",
        flow: "authorizationCode",
        tokenUrl: "https://token.example.com/token",
        authorizationUrl: "https://auth.example.com/authorize",
        clientIdSecretId: "petstore_client_id",
        clientSecretSecretId: "petstore_client_secret",
        scopes: ["read"],
      });

      // -------------------------------------------------------------
      // 3. Each user adds the spec with the auth they just minted.
      // -------------------------------------------------------------
      yield* aliceExec.openapi.addSpec({
        spec: specJson,
        scope: aliceScope.id as string,
        namespace: "petstore",
        baseUrl,
        oauth2: aliceOAuth2Auth,
      });
      yield* bobExec.openapi.addSpec({
        spec: specJson,
        scope: bobScope.id as string,
        namespace: "petstore",
        baseUrl,
        oauth2: bobOAuth2Auth,
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
      const aliceConn = aliceConnections.find((c) => c.id === aliceAuth.connectionId);
      expect(String(aliceConn?.scopeId)).toBe("user-alice");

      const bobConnections = yield* bobExec.connections.list();
      const bobConn = bobConnections.find((c) => c.id === bobAuth.connectionId);
      expect(String(bobConn?.scopeId)).toBe("user-bob");

      const adminConnectionIds = new Set(
        (yield* adminExec.connections.list()).map((c) => c.id as string),
      );
      expect(adminConnectionIds).not.toContain(String(aliceAuth.connectionId));
      expect(adminConnectionIds).not.toContain(String(bobAuth.connectionId));

      // -------------------------------------------------------------
      // 6. Connection-owned secrets are filtered from secrets.list().
      //    Alice only sees the org client creds; her access / refresh
      //    tokens are hidden behind the Connection primitive.
      // -------------------------------------------------------------
      const aliceSecretIds = new Set(
        (yield* aliceExec.secrets.list()).map((s) => String(s.id)),
      );
      expect(aliceSecretIds).toContain("petstore_client_id");
      expect(aliceSecretIds).toContain("petstore_client_secret");
      expect(aliceSecretIds).not.toContain(`${aliceAuth.connectionId}.access_token`);
      expect(aliceSecretIds).not.toContain(`${aliceAuth.connectionId}.refresh_token`);
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
  it.effect("clientCredentials sign-in is per-user with a stable shared connection name", () =>
    Effect.gen(function* () {
      const secretStore = new Map<string, string>();
      const key = (scope: string, id: string) => `${scope} ${id}`;
      const memoryProvider: SecretProvider = {
        key: "memory",
        writable: true,
        get: (id, scope) => Effect.sync(() => secretStore.get(key(scope, id)) ?? null),
        set: (id, value, scope) =>
          Effect.sync(() => {
            secretStore.set(key(scope, id), value);
          }),
        delete: (id, scope) => Effect.sync(() => secretStore.delete(key(scope, id))),
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
        onElicitation: "accept-all",
      });
      const aliceExec = yield* createExecutor({
        scopes: [aliceScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
      });
      const bobExec = yield* createExecutor({
        scopes: [bobScope, orgScope],
        adapter,
        blobs,
        plugins,
        onElicitation: "accept-all",
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
      }, { preconnect: originalFetch.preconnect });

      const startInput = {
        connectionId: "shared-petstore-oauth",
        displayName: "Petstore",
        securitySchemeName: "oauth2",
        tokenUrl: "https://token.example.com/token",
        clientIdSecretId: "client_id",
        clientSecretSecretId: "client_secret",
        scopes: ["read"],
      };
      const startClientCredentials = (
        exec: typeof adminExec,
        tokenScope: ScopeId,
        input: typeof startInput,
      ) =>
        Effect.gen(function* () {
          const started = yield* exec.oauth.start({
            endpoint: input.tokenUrl,
            redirectUrl: input.tokenUrl,
            connectionId: input.connectionId,
            tokenScope: tokenScope as string,
            pluginId: "openapi",
            identityLabel: `${input.displayName} OAuth`,
            strategy: {
              kind: "client-credentials",
              tokenEndpoint: input.tokenUrl,
              clientIdSecretId: input.clientIdSecretId,
              clientSecretSecretId: input.clientSecretSecretId,
              scopes: input.scopes,
            },
          });
          if (!started.completedConnection) {
            throw new Error("expected clientCredentials flow");
          }
          return new OAuth2Auth({
            kind: "oauth2",
            connectionId: started.completedConnection.connectionId,
            securitySchemeName: input.securitySchemeName,
            flow: "clientCredentials",
            tokenUrl: input.tokenUrl,
            authorizationUrl: null,
            clientIdSecretId: input.clientIdSecretId,
            clientSecretSecretId: input.clientSecretSecretId,
            scopes: input.scopes,
          });
        });

      // Admin adds the org-scoped source with an initial oauth2
      // pointer — same shape the onboarding UI writes via `addSpec`.
      // Admin's scope stack is [org] so their sign-in resolves the
      // org-level creds and writes the connection at org.
      const adminAuth = yield* startClientCredentials(adminExec, orgScope.id, startInput);
      yield* adminExec.openapi.addSpec({
        spec: specJson,
        scope: orgScope.id as string,
        namespace: "petstore",
        baseUrl,
        oauth2: adminAuth,
      });

      // Alice signs in → resolves her shadowed user-scope creds
      // (`alice-client`), mints her own token, writes at user-alice.
      const aliceAuth = yield* startClientCredentials(aliceExec, aliceScope.id, startInput);
      // Bob signs in → no user-scope shadow, falls through to the
      // org defaults (`org-client`), writes at user-bob.
      const bobAuth = yield* startClientCredentials(bobExec, bobScope.id, startInput);

      // ---- Regression assertions ----

      // (1) All three startOAuth calls return the SAME connection
      // id — it's a stable *name* carried by the source config. No
      // UUID-per-click churn, and the id does not have to be tied to
      // the source namespace.
      const stableId = startInput.connectionId;
      expect(adminAuth.connectionId).toBe(stableId);
      expect(aliceAuth.connectionId).toBe(stableId);
      expect(bobAuth.connectionId).toBe(stableId);

      // (2) Each user's physical row lives at their own scope. The
      // id *string* collides across scopes intentionally — that's
      // what lets a single `source.oauth2.connectionId` resolve
      // per-caller via `findInnermostConnectionRow`.
      const aliceConn = (yield* aliceExec.connections.list()).find(
        (c) => c.id === stableId && String(c.scopeId) === "user-alice",
      );
      const bobConn = (yield* bobExec.connections.list()).find(
        (c) => c.id === stableId && String(c.scopeId) === "user-bob",
      );
      const orgConn = (yield* adminExec.connections.list()).find((c) => c.id === stableId);
      expect(aliceConn).toBeDefined();
      expect(bobConn).toBeDefined();
      expect(orgConn).toBeDefined();
      expect(String(orgConn?.scopeId)).toBe("org");

      // (3) Scope-stacked secret resolution produced per-user tokens.
      // The exchange call Alice made used her shadowed value; Bob's
      // fell through to the org default.
      expect(tokenCalls).toContain("alice-client");
      expect(tokenCalls.filter((v) => v === "org-client").length).toBeGreaterThan(0);

      // (4) Each user's invocation resolves their OWN row and gets
      // their OWN token — not whatever the last signer happened to
      // mint. This is the core multi-user regression.
      yield* aliceExec.openapi.updateSource("petstore", orgScope.id as string, {
        oauth2: aliceAuth,
      });
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
      yield* startClientCredentials(aliceExec, aliceScope.id, startInput);
      const countAfter = (yield* aliceExec.connections.list()).filter(
        (c) => c.id === stableId,
      ).length;
      expect(countAfter).toBe(countBefore);
    }),
  );
});
