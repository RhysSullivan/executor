// ---------------------------------------------------------------------------
// End-to-end test for the OAuth2 `client_credentials` grant on the OpenAPI
// plugin — the DealCloud-style scenario where a spec declares ONLY a
// `clientCredentials` flow (no authorizationCode, no user-interactive
// popup, no PKCE).
//
// Regression: production 500s at `/api/scopes/:scope/openapi/oauth/start`
// for a DealCloud spec. The UI sent `flow: "authorizationCode"` with an
// empty `authorizationUrl` because the spec had no such flow — `new
// URL("")` inside `buildAuthorizationUrl` threw `TypeError: Invalid URL`,
// escaped as an Effect defect, returned 500.
//
// The fix: support `flow: "clientCredentials"` end-to-end. `startOAuth`
// does the token exchange inline (there is no user consent step), writes
// the access token to the caller-named secret at the caller-pinned
// scope, and returns a completed `OAuth2Auth`. No session row, no
// `completeOAuth` round-trip, no popup.
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
// Test API — single endpoint that echoes the Authorization header.
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
// Fetch override — records the POST body the plugin sends to the token
// endpoint so the test can assert it's a spec-compliant client_credentials
// request, and returns a distinct access_token each call so the test can
// tell a re-exchange apart from a cached value.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

type TokenCall = {
  readonly grantType: string | null;
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly scope: string | null;
};

const mockClientCredentialsFetch = (args: {
  readonly calls: TokenCall[];
  readonly accessTokens: readonly string[];
  readonly expiresIn?: number;
}) => {
  let callIndex = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const bodyText =
      init?.body instanceof URLSearchParams
        ? init.body.toString()
        : typeof init?.body === "string"
          ? init.body
          : "";
    const params = new URLSearchParams(bodyText);
    args.calls.push({
      grantType: params.get("grant_type"),
      clientId: params.get("client_id"),
      clientSecret: params.get("client_secret"),
      scope: params.get("scope"),
    });
    const token =
      args.accessTokens[Math.min(callIndex, args.accessTokens.length - 1)] ??
      "unknown";
    callIndex += 1;
    const body: Record<string, unknown> = {
      access_token: token,
      token_type: "Bearer",
    };
    if (typeof args.expiresIn === "number") body.expires_in = args.expiresIn;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestLayer)("OpenAPI client_credentials OAuth", (it) => {
  it.effect(
    "startOAuth exchanges tokens inline and makes them usable at invoke time",
    () =>
      Effect.gen(function* () {
        // Flat in-memory secret provider — no list() so the scope-walk
        // is the only resolver. Matches multi-scope-oauth.test.ts.
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
        const userScope = new Scope({
          id: ScopeId.make("user-alice"),
          name: "alice",
          createdAt: now,
        });

        const adminExec = yield* createExecutor({
          scopes: [orgScope],
          adapter,
          blobs,
          plugins,
        });
        const userExec = yield* createExecutor({
          scopes: [userScope, orgScope],
          adapter,
          blobs,
          plugins,
        });

        // Admin seeds the shared client_id + client_secret at the org.
        yield* adminExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("dealcloud_client_id"),
            scope: orgScope.id,
            name: "DealCloud Client ID",
            value: "client-abc",
          }),
        );
        yield* adminExec.secrets.set(
          new SetSecretInput({
            id: SecretId.make("dealcloud_client_secret"),
            scope: orgScope.id,
            name: "DealCloud Client Secret",
            value: "secret-xyz",
          }),
        );

        // Pre-seed the source row with an OAuth2Auth the completed flow
        // will fill in. Using `flow: "clientCredentials"` and a null
        // refreshTokenSecretId — DealCloud doesn't issue refresh tokens.
        yield* userExec.openapi.addSpec({
          spec: specJson,
          scope: userScope.id as string,
          namespace: "dealcloud",
          baseUrl: "",
          oauth2: new OAuth2Auth({
            kind: "oauth2",
            securitySchemeName: "oauth2",
            flow: "clientCredentials",
            tokenUrl: "https://token.example.com/token",
            clientIdSecretId: "dealcloud_client_id",
            clientSecretSecretId: "dealcloud_client_secret",
            accessTokenSecretId: "dealcloud_access_token_alice",
            refreshTokenSecretId: null,
            tokenType: "Bearer",
            expiresAt: null,
            scope: null,
            scopes: ["data"],
          }),
        });

        const calls: TokenCall[] = [];
        mockClientCredentialsFetch({
          calls,
          accessTokens: ["alice-token-1"],
        });

        // -------------------------------------------------------------
        // startOAuth for clientCredentials: no authorizationUrl, no
        // popup, no completeOAuth. The plugin exchanges tokens inline
        // and returns the completed auth.
        // -------------------------------------------------------------
        const started = yield* userExec.openapi.startOAuth({
          displayName: "DealCloud",
          securitySchemeName: "oauth2",
          flow: "clientCredentials",
          tokenUrl: "https://token.example.com/token",
          clientIdSecretId: "dealcloud_client_id",
          clientSecretSecretId: "dealcloud_client_secret",
          scopes: ["data"],
          tokenScope: userScope.id as unknown as string,
          accessTokenSecretId: "dealcloud_access_token_alice",
        });

        // The response is a completed OAuth2Auth — no authorizationUrl,
        // no sessionId, no subsequent completeOAuth step.
        if (started.flow !== "clientCredentials") {
          throw new Error("expected clientCredentials flow");
        }
        expect(started.auth.accessTokenSecretId).toBe(
          "dealcloud_access_token_alice",
        );
        expect(started.auth.refreshTokenSecretId).toBeNull();

        // The token endpoint call is RFC 6749 §4.4 compliant.
        expect(calls).toHaveLength(1);
        expect(calls[0]!.grantType).toBe("client_credentials");
        expect(calls[0]!.clientId).toBe("client-abc");
        expect(calls[0]!.clientSecret).toBe("secret-xyz");
        expect(calls[0]!.scope).toBe("data");

        // Invoking the tool through the user executor injects the
        // freshly-minted bearer.
        const result = (yield* userExec.tools.invoke(
          "dealcloud.items.echoHeaders",
          {},
          autoApprove,
        )) as {
          data: { authorization?: string } | null;
          error: unknown;
        };
        expect(result.error).toBeNull();
        expect(result.data?.authorization).toBe("Bearer alice-token-1");

        // The access token is pinned to alice's scope, not the org.
        const userRows = yield* userExec.secrets.list();
        const accessRow = userRows.find(
          (r) => (r.id as unknown as string) === "dealcloud_access_token_alice",
        );
        expect(accessRow?.scopeId as unknown as string).toBe("user-alice");

        // Admin scope does not see alice's access token.
        const adminIds = new Set(
          (yield* adminExec.secrets.list()).map(
            (s) => s.id as unknown as string,
          ),
        );
        expect(adminIds).not.toContain("dealcloud_access_token_alice");
      }),
  );
});
